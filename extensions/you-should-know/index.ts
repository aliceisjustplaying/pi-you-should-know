// You Should Know: a port of Claude Code's built-in `cc-plugin-you-should-know` mod (v2.1.287).
//
// Every 6th turn of an agent run, fork the live conversation (same model, same cached prefix,
// via turn_end's `context.llmMessages`), append the original detect prompt, and ask whether
// there's something the user should know but probably missed. Most of the time the answer is
// `learn: none`. When it isn't, show a note above the editor. Respond with /ysk (or alt+shift+y).
//
// Reference (extracted from the Claude Code binary): ~/.pi/agent/reference/you-should-know/
//
// Outside the terminal UI (RPC clients such as T3 Code) there is no widget or custom component.
// Each note is sent once as a notify, `[ysk:<id>] <tag> · <line> (<evidence>)` followed by its
// explanation, for the client to show and answer itself. The client reports each answer back
// with `/ysk answer <id> <action>`.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync, unlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";

// ---- constants copied from the CC mod ----
const CHECK_EVERY_STEPS = 6; // var kr=6
const PROMPTS_SURVIVED = 2; // var Tr=2: a note survives this many user prompts
const MAX_SKIP = 16; // var dt=16
const FREE_IGNORES = 2; // var ut=2
const HISTORY_MAX = 50; // var $t=50
const MAX_NOTES = 5; // local: notes pile up until answered; oldest drops past this
const backoff = (ignoredInARow: number) =>
	ignoredInARow <= FREE_IGNORES ? 0 : Math.min(MAX_SKIP, 2 ** (ignoredInARow - FREE_IGNORES - 1)); // kn()

const HERE = dirname(fileURLToPath(import.meta.url));
const DETECT_TEMPLATE = readFileSync(join(HERE, "detect-prompt.md"), "utf8");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const STATE_FILE = join(AGENT_DIR, "you-should-know", "state.json");
const KNOWLEDGE_FILE = join(AGENT_DIR, "you-should-know", "knowledge.jsonl");
const LOG_FILE = join(AGENT_DIR, "you-should-know", "checks.jsonl");
const WIDGET = "you-should-know";
const DEBUG = !!process.env.YSK_DEBUG;

// ---- herdr subagent relay ----
// A herdr child gets PI_SUBAGENT_ACTIVITY_FILE=<parentSessionDir>/artifacts/<parentSessionId>/subagent-activity/<id>.json
// (pi-herdr-subagents activity.ts getSubagentActivityFile). The child drops notes into a sibling inbox;
// the parent watches its own <sessionDir>/artifacts/<sessionId>/you-should-know-inbox/ and shows them.
const INBOX = "you-should-know-inbox";
const CHILD_ACTIVITY = process.env.PI_SUBAGENT_ACTIVITY_FILE?.trim();
// The activity file is either <artifactDir>/subagent-activity/<id>.json or, from the harness
// driver, <artifactDir>/subagent-activity-<id>.json. Either way the inbox sits in <artifactDir>.
const CHILD_ARTIFACT_DIR = CHILD_ACTIVITY
	? basename(dirname(CHILD_ACTIVITY)) === "subagent-activity" ? dirname(dirname(CHILD_ACTIVITY)) : dirname(CHILD_ACTIVITY)
	: undefined;
const CHILD_INBOX = CHILD_ARTIFACT_DIR ? join(CHILD_ARTIFACT_DIR, INBOX) : undefined;
const CHILD_NAME = process.env.PI_SUBAGENT_NAME?.trim() || process.env.PI_SUBAGENT_ID?.trim() || "subagent";

// ---- prompts (verbatim from the CC mod) ----
const PREAMBLE = DETECT_TEMPLATE.slice(0, DETECT_TEMPLATE.indexOf("</system-reminder>") + "</system-reminder>".length);

const list = (xs: string[]) => (xs.length > 0 ? xs.map((x) => `- ${x}`).join("\n") : "(nothing yet)"); // ft()
const detectPrompt = (seen: string[], known: string[]) =>
	DETECT_TEMPLATE.replace("{{SEEN}}", list(seen)).replace("{{KNOWN}}", list(known)); // dn()

type Direction = "first" | "simpler_words" | "less_detail" | "more_detail";
const DIRECTION_ASK: Record<Exclude<Direction, "first">, string> = {
	simpler_words: "in simpler words",
	less_detail: "with less detail",
	more_detail: "in more detail",
};
const DIRECTION_RULE: Record<Direction, string> = {
	first: "At most 100 words; fewer when the thing needs no introduction.",
	simpler_words:
		"Same content as before, said more plainly: shorter sentences, everyday words, no symbols or arrows, no technical terms at all. At most 100 words.",
	less_detail:
		"Strip it to the single most important point: what the thing is in one clause, then the one consequence and the choice. No technical terms, no sketch. At most 45 words.",
	more_detail:
		"Now name the real parts: show the actual config keys, file or function involved (each introduced as everyday words then the name in backticks), and one edge case that would surprise them. Still for a reader with no context; still no invented terms. At most 160 words; a sketch of the real structure is welcome here if it helps.",
};
const shape = (rule: string) =>
	"Write for someone smart who knows nothing about this code and is context-switching constantly: assume they remember no term and no detail from earlier. One idea only. " +
	rule +
	'\nShape:\n1. A title line: `**` two to six plain words that state the point `**`.\n2. First sentence: what the thing IS, in everyday words, with a tiny example of what it does or produces (e.g. "a health check is a step that asks each server one question on a timer and saves the answer, like "are you still up? yes/no""). Never open with a name they have not used; never assume they know what it is.\n3. Then the before/after or the two options as two short lines, using their own numbers and names ("list it once at the top \u2192 asked 1\u00d7 \u2026 inside each job \u2192 asked 3\u00d7"). If, and only if, a small ASCII sketch shows this better than two lines of text, put one in a ``` fenced block, at most 60 characters wide and 6 lines tall; otherwise no sketch.\n4. Then the concrete consequence in their terms (a count, a cost, a wrong number they would have reported) and, last, the choice they are making, in one sentence.\nNo analogy unless it is genuinely clearer than the example, and never both. Any code name appears only after its everyday description, in backticks. Never coin a term or nickname. No headings other than the title, no bullets, no "in summary". Short words, short sentences.'; // pn()
const explainPrompt = (line: string, prev?: { direction: Exclude<Direction, "first">; text: string }) =>
	`${PREAMBLE}\nAnswer straight away: do not think it over first, do not call any tool.\nThe person watching you work said yes to: "${line}"\n` +
	(prev ? `You already showed them this, and they asked for it ${DIRECTION_ASK[prev.direction]}:\n${prev.text}\nDo not repeat it; rewrite it.\n` : "") +
	shape(DIRECTION_RULE[prev?.direction ?? "first"]) +
	"\nOutput only the explanation."; // mn()

// ---- persistent state (across sessions, like CC's plugin store) ----
type State = { enabled: boolean; seen: string[]; known: string[]; ignoredInARow: number; skip: number };
// Each feedback write is one append, so another Pi process cannot overwrite it
// with an older in-memory snapshot. state.json remains the readable snapshot.
function readKnowledge(legacy: string[]): string[] {
	const known = new Map(legacy.map((line) => [norm(line), line]));
	if (existsSync(KNOWLEDGE_FILE)) for (const line of readFileSync(KNOWLEDGE_FILE, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (typeof entry.line !== "string" || typeof entry.known !== "boolean") continue;
			if (entry.known) known.set(norm(entry.line), entry.line);
			else known.delete(norm(entry.line));
		} catch { /* An interrupted final append is ignored. The next starts on a new line. */ }
	}
	return [...known.values()].slice(-HISTORY_MAX);
}
function atomicJson(file: string, value: unknown) {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = file + ".tmp-" + process.pid;
	try {
		writeFileSync(temporary, JSON.stringify(value, null, 2));
		renameSync(temporary, file);
	} finally { rmSync(temporary, { force: true }); }
}
function loadState(): State {
	let state: State = { enabled: true, seen: [], known: [], ignoredInARow: 0, skip: 0 };
	if (existsSync(STATE_FILE)) state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
	state.known = readKnowledge(state.known);
	return state;
}
function saveState(s: State) {
	s.known = readKnowledge(s.known);
	atomicJson(STATE_FILE, s);
}
function log(entry: Record<string, unknown>) {
	try {
		mkdirSync(dirname(LOG_FILE), { recursive: true });
		appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
	} catch {}
}

// ---- output parsing (the CC mod's Cr()) ----
type Tag = "You should know" | "Heads up";
type Note = { id: string; line: string; tag: Tag; evidence?: string; explanation?: string; from?: string; shownAt: number; promptsSurvived: number; countedIgnored?: boolean };
type Parsed = { kind: "none" } | { kind: "parse_failed" } | { kind: "line"; line: string; tag: Tag; evidence?: string; explanation?: string };
const strip = (s: string) => s.replace(/^[\s>*_`"'\u201C\u201D\u2018\u2019-]+/, "");
function parse(text: string): Parsed {
	const lines = text.split("\n");
	const li = lines.findIndex((l) => /^learn\s*:/i.test(strip(l)));
	if (li === -1) return { kind: "parse_failed" };
	const line = strip(lines[li]).replace(/^learn\s*:\s*/i, "").replace(/[*_`\s]+$/, "").trim();
	if (line === "" || /^none\.?$/i.test(line)) return { kind: "none" };
	const ti = lines.findIndex((l, i) => i > li && /^tag\s*:/i.test(strip(l)));
	const tag: Tag = ti !== -1 && /heads[\s-]*up/i.test(lines[ti]) ? "Heads up" : "You should know";
	const ei = lines.findIndex((l, i) => i > li && /^explain\s*:/i.test(strip(l)));
	const vi = lines.findIndex((l, i) => i > li && (ei === -1 || i < ei) && /^evidence\s*:/i.test(strip(l)));
	const ev = vi === -1 ? "" : strip(lines[vi]).replace(/^evidence\s*:\s*/i, "").trim();
	const evidence = ev && !/^none\.?$/i.test(ev) ? ev : undefined;
	let explanation: string | undefined;
	if (ei !== -1) {
		const first = strip(lines[ei]).replace(/^explain\s*:\s*/i, "");
		explanation = [first, ...lines.slice(ei + 1)].join("\n").trim() || undefined;
	}
	return { kind: "line", line, tag, evidence, explanation };
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); // Co()

const textOf = (msg: { content: unknown }) =>
	Array.isArray(msg.content)
		? msg.content
				.filter((c: any) => c?.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join("\n")
				.trim()
		: "";

export default function (pi: ExtensionAPI) {
	let state = loadState();
	let notes: Note[] = []; // oldest first; notes[0] is the one /ysk and alt+x act on
	let answered = new Map<string, { note: Note; action: string }>();
	let inFlight: AbortController | undefined;
	let promptCounter = 0; // stands in for CC's turnId staleness check
	let checks = 0;
	const remember = (line: string, known: boolean) => {
		mkdirSync(dirname(KNOWLEDGE_FILE), { recursive: true });
		appendFileSync(KNOWLEDGE_FILE, "\n" + JSON.stringify({ line, known }) + "\n");
		state.known = readKnowledge(state.known);
	};

	const pickModel = (ctx: ExtensionContext) => {
		const o = process.env.YSK_MODEL; // optional override: provider/model-id
		if (o && o.includes("/")) {
			const i = o.indexOf("/");
			const m = ctx.modelRegistry.find(o.slice(0, i), o.slice(i + 1));
			if (m) return m;
		}
		return ctx.model; // CC uses the main session's model (JR() -> mainLoopModel)
	};

	const notesFile = (ctx: ExtensionContext) =>
		ctx.sessionManager.getSessionDir()
			? join(ctx.sessionManager.getSessionDir(), "artifacts", ctx.sessionManager.getSessionId(), "you-should-know.json")
			: undefined;
	const persistNotes = (ctx: ExtensionContext) => {
		const file = notesFile(ctx);
		if (file) atomicJson(file, { notes, answered: [...answered] });
	};

	const render = (ctx: ExtensionContext) => {
		persistNotes(ctx);
		if (ctx.mode !== "tui") return;
		if (notes.length === 0) {
			ctx.ui.setWidget(WIDGET, undefined);
			return;
		}
		const shown = [...notes];
		ctx.ui.setWidget(WIDGET, (_tui, theme) => {
			const c = new Container();
			shown.forEach((n, i) => {
				const mark = i === 0 ? theme.fg("accent", "\u2726 ") : theme.fg("dim", "\u2727 ");
				const tag = i === 0 ? theme.fg("accent", theme.bold(n.tag)) : theme.fg("dim", n.tag);
				const from = n.from ? theme.fg("dim", ` (${n.from})`) : "";
				c.addChild(new Text(mark + tag + from + theme.fg("dim", " \u00b7 ") + n.line, 0, 0));
			});
			return c;  // (no key hint line: alt+x dismisses, /ysk or alt+shift+y responds)
		});
	};

	const clearNotes = (ctx: ExtensionContext) => {
		notes = [];
		render(ctx);
	};

	const popNote = (ctx: ExtensionContext) => {
		const n = notes.shift();
		render(ctx);
		return n;
	};

	async function fork(ctx: ExtensionContext, llmMessages: any[], prompt: string, signal: AbortSignal) {
		const model = pickModel(ctx);
		if (!model) throw new Error("no model");
		const messages = [
			...llmMessages,
			{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() },
		];
		const hasSystem = llmMessages[0]?.role === "system";
		const res = await ctx.modelRegistry.complete(
			model,
			{ messages, ...(hasSystem ? {} : { systemPrompt: ctx.getSystemPrompt() }) } as any,
			{ signal, sessionId: ctx.sessionManager.getSessionId(), onPayload: (p: unknown) => alignWithMain(p) } as any,
		);
		return { text: textOf(res as any), usage: (res as any).usage, stopReason: (res as any).stopReason };
	}

	let lastLlmMessages: any[] = [];

	/**
	 * The main conversation's last request, exactly as sent. The fork is only
	 * cheap if its bytes start the same way, and they did not: it sent no tools
	 * and no thinking setting, so Anthropic kept the tools and system prompt
	 * cached but wrote every message again — about 255k tokens and $1.30 per
	 * check on Opus 5.5 (155 checks, $56.76 in checks.jsonl before this fix).
	 */
	let mainPayload: Record<string, unknown> | undefined;
	const forkPayloads = new WeakSet<object>();
	pi.on("before_provider_request", (e) => {
		const p = e.payload;
		if (!p || typeof p !== "object" || forkPayloads.has(p as object)) return; // never align to our own fork
		mainPayload = p as Record<string, unknown>;
	});

	/** How the last fork lined up with the main request; logged with each check. */
	let lastAlign: Record<string, unknown> = {};

	/**
	 * Cache fix, take two. The first version rebuilt the fork's messages and moved
	 * the cache marker to the message before the detect prompt. Anthropic only finds
	 * a cached prefix by looking back about 20 content blocks from a marker, and
	 * most checks landed outside that window: checks.jsonl showed ~21k tokens read
	 * (tools + system only) and 130-300k written, about $1 per check.
	 *
	 * Now the fork reuses the main request's message list byte for byte, including
	 * its cache marker, so the fork reads exactly what the main request cached. The
	 * messages after it (the turn that just ended) and the detect prompt carry no
	 * marker: they are paid once as plain input and never written to the cache.
	 */
	const alignWithMain = (forked: unknown): unknown => {
		const main = mainPayload;
		lastAlign = { aligned: false };
		if (!main || !forked || typeof forked !== "object") return markFork(undefined, (lastAlign.why = "no main payload"));
		const f = forked as Record<string, unknown>;
		if (main["model"] !== f["model"]) return markFork(undefined, (lastAlign.why = "model differs"));
		const key = Array.isArray(f["messages"]) ? "messages" : Array.isArray(f["input"]) ? "input" : undefined;
		if (!key || !Array.isArray(main[key])) return markFork(undefined, (lastAlign.why = "no message list"));
		if (key === "input") return markFork({ ...main, input: f["input"] }, undefined, true);
		const mainMsgs = main[key] as any[];
		const forkMsgs = (f[key] as any[]).map(unmark);
		const same = commonPrefix(mainMsgs, forkMsgs);
		lastAlign = { aligned: true, mainLen: mainMsgs.length, forkLen: forkMsgs.length, common: same };
		if (same === 0) return markFork({ ...main, messages: forkMsgs }, undefined, true);
		const head = mainMsgs.slice(0, same);
		if (same < mainMsgs.length) {
			// Main's marker fell outside the match: put the same marker on the last
			// matching message so Anthropic can still look back to main's cache.
			const marker = findMarker(mainMsgs) ?? { type: "ephemeral" };
			const last = unmark(head[same - 1]);
			if (Array.isArray(last?.content) && last.content.length > 0) {
				const blocks = last.content.slice();
				const at = blocks.findLastIndex((b: any) => b?.type !== "thinking" && b?.type !== "redacted_thinking");
				if (at >= 0) blocks[at] = { ...blocks[at], cache_control: marker };
				head[same - 1] = { ...last, content: blocks };
			}
		}
		// Main's own messages (marker included), then the new tail, unmarked.
		return markFork({ ...main, messages: [...head, ...forkMsgs.slice(same)] }, undefined, true);
	};
	const markFork = (payload: Record<string, unknown> | undefined, _why?: string, _aligned?: boolean) => {
		if (payload) forkPayloads.add(payload);
		return payload;
	};
	const unmark = (m: any) =>
		Array.isArray(m?.content) ? { ...m, content: m.content.map(({ cache_control: _drop, ...b }: any) => b) } : m;
	const sameMsg = (a: any, b: any) => JSON.stringify(unmark(a)) === JSON.stringify(unmark(b));
	const findMarker = (msgs: any[]) => {
		for (let i = msgs.length - 1; i >= 0; i--)
			for (const b of Array.isArray(msgs[i]?.content) ? msgs[i].content : []) if (b?.cache_control) return b.cache_control;
		return undefined;
	};
	/** How many leading messages are identical once cache markers are ignored. */
	const commonPrefix = (main: any[], fork: any[]) => {
		let i = 0;
		while (i < main.length && i < fork.length && sameMsg(main[i], fork[i])) i++;
		return i;
	};

	function relayToParent(n: { line: string; tag: Tag; evidence?: string; explanation?: string; from: string }) {
		try {
			mkdirSync(CHILD_INBOX!, { recursive: true });
			const base = join(CHILD_INBOX!, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
			writeFileSync(base + ".tmp", JSON.stringify(n));
			renameSync(base + ".tmp", base + ".json"); // atomic: parent never reads a half-written note
		} catch (err) {
			log({ event: "relay_failed", error: String(err) });
		}
	}

	// Parent side: pick up notes relayed by herdr subagents.
	const queuedRelays = new Set<string>();
	let inboxTimer: ReturnType<typeof setInterval> | undefined;
	const inboxDir = (ctx: ExtensionContext) =>
		join(ctx.sessionManager.getSessionDir(), "artifacts", ctx.sessionManager.getSessionId(), INBOX);
	function drainInbox(ctx: ExtensionContext) {
		const dir = inboxDir(ctx);
		if (!existsSync(dir)) return;
		const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
		if (files.length === 0) return;
		const delivered = new Set(ctx.sessionManager.getEntries().flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === "you-should-know" &&
			entry.details && typeof entry.details === "object" && "relayId" in entry.details
				? [entry.details.relayId] : []));
		for (const f of files) {
			const path = join(dir, f);
			try {
				if (delivered.has(f)) { unlinkSync(path); queuedRelays.delete(f); continue; }
				if (queuedRelays.has(f)) continue;
				const n = JSON.parse(readFileSync(path, "utf8"));
				if (!n?.line || !state.enabled) continue;
				// Feed it to the parent agent as a message. Busy: steer into the current run.
				// Idle: append to Pi's durable conversation without waking the agent.
				const tag = n.tag === "Heads up" ? "Heads up" : "You should know";
				const body = [`${tag} \u00b7 ${n.line}`, ...(n.evidence ? [`Evidence: ${n.evidence}`] : []), ...(n.explanation ? ["", n.explanation] : [])]
					.join("\n").split("\n").map((l: string) => (l === "" ? ">" : `> ${l}`)).join("\n");
				const idle = ctx.isIdle();
				pi.sendMessage(
					{
						customType: "you-should-know",
						content: `Your subagent "${n.from ?? "subagent"}" raised a note its side agent thinks you (and the user) should know. It's about the subagent's work; you can't see its conversation. Weigh it and act or mention it if it matters:\n${body}`,
						display: true,
						details: { ...n, relayId: f },
					},
					idle ? {} : { deliverAs: "steer" },
				);
				queuedRelays.add(f);
				log({ event: "relayed_in", from: n.from, line: n.line, deliverAs: idle ? "persisted" : "steer" });
			} catch {}
		}
	}

	pi.on("session_start", (_e, ctx) => {
		state = loadState();
		queuedRelays.clear();
		inFlight?.abort();
		inFlight = undefined;
		notes = [];
		answered = new Map();
		try {
			const file = notesFile(ctx);
			if (file) {
				const saved = JSON.parse(readFileSync(file, "utf8"));
				notes = saved.notes;
				answered = new Map(saved.answered);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		promptCounter = 0;
		render(ctx);
		if (inboxTimer) clearInterval(inboxTimer);
		inboxTimer = undefined;
		if (ctx.hasUI) {
			inboxTimer = setInterval(() => drainInbox(ctx), 2000);
			inboxTimer.unref?.();
		}
	});

	pi.on("session_shutdown", () => {
		inFlight?.abort();
		inFlight = undefined;
		if (inboxTimer) clearInterval(inboxTimer);
		inboxTimer = undefined;
	});

	// T3 accepts notices between turns.
	const noteText = (n: Note) =>
		`[ysk:${n.id}] ${n.tag} \u00b7 ${n.line}${n.evidence ? ` (${n.evidence})` : ""}` +
		(n.explanation ? `\n\n${n.explanation}` : "");
	function announce(ctx: ExtensionContext, n: Note) {
		ctx.ui.notify(noteText(n), "info");
		persistNotes(ctx);
	}


	// A note that survives PROMPTS_SURVIVED user prompts unanswered counts as ignored (for backoff),
	// but stays on screen so notes can pile up until you answer or dismiss them.
	// Unanswered notes count in RPC clients too. Extension commands are not user prompts.
	pi.on("input", (e, ctx) => {
		if (e.source === "extension" || e.text.trim().startsWith("/ysk")) return;
		promptCounter++;
		let changed = false;
		for (const n of notes) {
			n.promptsSurvived++;
			if (n.countedIgnored || n.promptsSurvived < PROMPTS_SURVIVED) continue;
			n.countedIgnored = true;
			log({ event: "ignored_submit", line: n.line });
			state.ignoredInARow++;
			changed = true;
		}
		persistNotes(ctx);
		if (!changed) return;
		state.skip = backoff(state.ignoredInARow);
		saveState(state);
	});

	pi.on("turn_end", (e, ctx) => {
		lastLlmMessages = e.context.llmMessages as any[];
		if (!state.enabled || !ctx.hasUI) return;
		const step = e.turnIndex;
		if (!(step > 0 && step % CHECK_EVERY_STEPS === 0)) return;
		if (inFlight) return;
		if (state.skip > 0) {
			state.skip--;
			saveState(state);
			return;
		}

		const ac = new AbortController();
		inFlight = ac;
		const askedAt = promptCounter;
		const seen = [...state.seen];
		const known = [...state.known];
		const t0 = Date.now();
		checks++;
		// Fire and forget: never block the main agent.
		void (async () => {
			let outcome = "error";
			let extra: Record<string, unknown> = {};
			try {
				const r = await fork(ctx, lastLlmMessages, detectPrompt(seen, known), ac.signal);
				extra = { usage: r.usage, stopReason: r.stopReason };
				if (ac.signal.aborted) outcome = "aborted";
				else if (!r.text) outcome = "empty";
				else {
					const p = parse(r.text);
					if (p.kind !== "line") outcome = p.kind;
					else if ([...seen, ...known].some((x) => norm(x) === norm(p.line))) outcome = "deduped";
					else if (promptCounter !== askedAt) outcome = "stale";
					else {
						outcome = "shown";
						extra.line = p.line;
						state.seen = [...state.seen, p.line].slice(-HISTORY_MAX);
						saveState(state);
						if (CHILD_INBOX) {
							// In a herdr subagent: hand the note to the parent instead of showing it here.
							// The parent can't fork our conversation, so write the explanation now.
							let explanation = p.explanation;
							if (!explanation) {
								try {
									explanation = (await fork(ctx, lastLlmMessages, explainPrompt(p.line), ac.signal)).text || undefined;
								} catch {}
							}
							relayToParent({ line: p.line, tag: p.tag, evidence: p.evidence, explanation, from: CHILD_NAME });
							outcome = "relayed";
							return;
						}
						const note: Note = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), line: p.line, tag: p.tag, evidence: p.evidence, explanation: p.explanation, shownAt: Date.now(), promptsSurvived: 0 };
						if (ctx.mode !== "tui" && !note.explanation) {
							// The client's "Explain" has nothing to ask, so write the explanation now.
							try {
								note.explanation = (await fork(ctx, lastLlmMessages, explainPrompt(p.line), ac.signal)).text || undefined;
							} catch {}
						}
						notes.push(note);
						while (ctx.mode === "tui" && notes.length > MAX_NOTES) log({ event: "overflow_dropped", line: notes.shift()!.line });
						render(ctx);
						if (ctx.mode !== "tui") announce(ctx, note);
					}
				}
			} catch (err) {
				outcome = ac.signal.aborted ? "aborted" : "error";
				extra.error = String(err);
			} finally {
				if (inFlight === ac) inFlight = undefined;
				log({ event: "check", step, outcome, ms: Date.now() - t0, align: lastAlign, ...extra });
				if (DEBUG) ctx.ui.notify(`you-should-know: step ${step} \u2192 ${outcome} (${Date.now() - t0}ms)`, "info");
			}
		})();
	});

	async function showExplanation(ctx: ExtensionContext, n: Note) {
		let text = n.explanation;
		if (!text) {
			ctx.ui.notify("One moment\u2026", "info");
			text = (await fork(ctx, lastLlmMessages, explainPrompt(n.line), new AbortController().signal)).text;
		}
		while (true) {
			const choice = ctx.mode !== "tui" ? await explainBySelect(ctx, n, text!) : await ctx.ui.custom<string>((_tui, theme, _kb, done) => {
				const c = new Container();
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				c.addChild(border);
				c.addChild(new Text(theme.fg("accent", `\u2726 ${n.tag}`), 1, 0));
				c.addChild(new Markdown(text!, 1, 1, getMarkdownTheme()));  // (keys, unlisted: 1/Enter understood, 2 chat, s simpler, l less, m more, 0/Esc dismiss)
				c.addChild(border);
				return {
					render: (w: number) => c.render(w),
					invalidate: () => c.invalidate(),
					handleInput: (d: string) => {
						if (d === "1" || matchesKey(d, "enter")) done("understood");
						else if (d === "2") done("chat");
						else if (d === "s") done("simpler_words");
						else if (d === "l") done("less_detail");
						else if (d === "m") done("more_detail");
						else if (d === "0" || matchesKey(d, "escape")) done("dismiss");
					},
				};
			});
			if (choice === "simpler_words" || choice === "less_detail" || choice === "more_detail") {
				ctx.ui.notify("Rewriting\u2026", "info");
				try {
					const r = await fork(
						ctx,
						lastLlmMessages,
						explainPrompt(n.line, { direction: choice, text: text! }),
						new AbortController().signal,
					);
					if (r.text) text = r.text;
				} catch (err) {
					ctx.ui.notify(`Couldn\u2019t write that explanation: ${err}`, "error");
				}
				continue;
			}
			log({ event: "explained", answer: choice, line: n.line });
			if (choice === "chat") chatInMain(n, text);
			return;
		}
	}

	// Outside the terminal UI: the explanation as a notice, then the same choices as a select.
	const EXPLAIN_OPTIONS = { Understood: "understood", "Chat in main session": "chat", "Simpler words": "simpler_words", "Less detail": "less_detail", "More detail": "more_detail" } as const;
	async function explainBySelect(ctx: ExtensionContext, n: Note, text: string) {
		ctx.ui.notify(`${n.tag} \u00b7 ${n.line}\n\n${text}`, "info");
		const pick = await ctx.ui.select(`${n.tag} \u00b7 ${n.line}`, Object.keys(EXPLAIN_OPTIONS));
		return pick ? EXPLAIN_OPTIONS[pick as keyof typeof EXPLAIN_OPTIONS] : "dismiss";
	}

	// CC's un(): quote the note into the main session.
	function chatInMain(n: Note, explanation?: string) {
		const body = [`${n.tag}${n.from ? ` (from subagent ${n.from})` : ""} \u00b7 ${n.line}`, ...(n.evidence ? [`Evidence: ${n.evidence}`] : []), ...(explanation ? ["", explanation] : [])]
			.join("\n")
			.split("\n")
			.map((l) => (l === "" ? ">" : `> ${l}`))
			.join("\n");
		pi.sendUserMessage(`Here is a note offered by a side agent:\n${body}`, { deliverAs: "followUp" });
	}

	async function respond(ctx: ExtensionContext, arg?: string) {
		if (arg === "on" || arg === "off") {
			state.enabled = arg === "on";
			saveState(state);
			if (!state.enabled) clearNotes(ctx);
			ctx.ui.notify(`You should know: ${state.enabled ? "on" : "off"}`, "info");
			return;
		}
		if (arg === "test") {
			// A sample note, shown at once, to check the display path without waiting for a real one.
			const note: Note = { id: "test" + crypto.randomUUID(), line: "This is a test note from /ysk test.", tag: "Heads up", evidence: "/ysk test", explanation: "Nothing is wrong. This note only checks that notes reach your screen.", shownAt: Date.now(), promptsSurvived: 0 };
			notes.push(note);
			render(ctx);
			if (ctx.mode !== "tui") ctx.ui.notify(noteText(note), "info");
			return;
		}
		if (arg?.startsWith("answer ")) {
			answerFromClient(ctx, arg.slice("answer ".length));
			return;
		}
		if (arg === "status") {
			ctx.ui.notify(
				`You should know: ${state.enabled ? "on" : "off"} \u00b7 ${checks} checks this session \u00b7 skip ${state.skip} \u00b7 model ${pickModel(ctx)?.id ?? "?"} \u00b7 log ${LOG_FILE}`,
				"info",
			);
			return;
		}
		if (notes.length === 0) {
			ctx.ui.notify(`Nothing to know right now. (${state.enabled ? `${checks} checks so far` : "off: /ysk on"})`, "info");
			return;
		}
		// RPC clients (T3) show and answer notes in their own UI; a second menu here only duplicates it.
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Answer notes where your client shows them.", "info");
			return;
		}
		const n = notes[0];
		const options = ["1 Learn more", "2 Knew this already", "3 Chat in main session", "0 Dismiss"];
		const pick = await ctx.ui.select(`${n.tag} \u00b7 ${n.line}`, options);
		if (!pick) return;
		if (notes[0] === n) popNote(ctx);
		else {
			notes = notes.filter((x) => x !== n);
			render(ctx);
		}
		state.ignoredInARow = 0;
		state.skip = 0;
		const k = pick[0];
		log({ event: "answer", answer: { "1": "learn_more", "2": "knew", "3": "chat", "0": "dismiss" }[k], line: n.line, msToAnswer: Date.now() - n.shownAt });
		if (k === "1") await showExplanation(ctx, n).catch((err) => ctx.ui.notify(`Couldn\u2019t write that explanation: ${err}`, "error"));
		else if (k === "2") remember(n.line, true);
		else if (k === "3") chatInMain(n, n.explanation);
		saveState(state);
	}

	// RPC clients answer notes in their own UI, then send `/ysk answer <id> <action>`
	// (T3 Code's actions: knew, dismiss, learn, send). The client already showed the
	// explanation or quoted the note to the agent, so this only records the answer.
	const CLIENT_ANSWERS: Record<string, string> = { knew: "knew", dismiss: "dismiss", learn: "learn_more", send: "chat" };
	function answerFromClient(ctx: ExtensionContext, rest: string) {
		const [id, action] = rest.trim().split(/\s+/);
		const answer = action && Object.hasOwn(CLIENT_ANSWERS, action) ? CLIENT_ANSWERS[action] : undefined;
		const prior = answered.get(id);
		const n = notes.find((x) => x.id === id) ?? prior?.note;
		if (n && action === "undo") {
			if (prior?.action === "knew") remember(n.line, false);
			answered.delete(id);
			if (!notes.some((x) => x.id === id)) notes.push(n);
			saveState(state);
			render(ctx);
			return;
		}
		if (!n || !answer) {
			log({ event: "answer_ignored", id, action, via: "client" });
			return;
		}
		answered.set(id, { note: n, action });
		notes = notes.filter((x) => x !== n);
		state.ignoredInARow = 0;
		state.skip = 0;
		if (answer === "knew") remember(n.line, true);
		saveState(state);
		render(ctx);
		log({ event: "answer", answer, via: "client", line: n.line, msToAnswer: Date.now() - n.shownAt });
	}

	// One keystroke: dismiss the top note, no menu.
	function quickDismiss(ctx: ExtensionContext) {
		const n = popNote(ctx);
		if (!n) return;
		state.ignoredInARow = 0;
		state.skip = 0;
		saveState(state);
		log({ event: "answer", answer: "dismiss", via: "alt+x", line: n.line, msToAnswer: Date.now() - n.shownAt });
	}

	pi.registerCommand("ysk", {
		description: "You should know: respond to the current note (/ysk on|off|status|test)",
		handler: async (args, ctx) => respond(ctx, args?.trim() || undefined),
	});
	pi.registerShortcut("alt+shift+y", { description: "You should know: respond to the current note", handler: (ctx) => respond(ctx) });
	pi.registerShortcut("alt+x", { description: "You should know: dismiss the top note", handler: (ctx) => quickDismiss(ctx) });
}
