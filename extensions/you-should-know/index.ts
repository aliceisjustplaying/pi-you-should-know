// You Should Know: a port of Claude Code's built-in `cc-plugin-you-should-know` mod (v2.1.287).
//
// Every 6th turn of an agent run, fork the live conversation (same model, same cached prefix,
// via turn_end's `context.llmMessages`), append the original detect prompt, and ask whether
// there's something the user should know but probably missed. Most of the time the answer is
// `learn: none`. When it isn't, show a note above the editor. Respond with /ysk (or alt+shift+y).
//
// Reference (extracted from the Claude Code binary): ~/.pi/agent/reference/you-should-know/

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
const STATE_FILE = join(homedir(), ".pi", "agent", "you-should-know", "state.json");
const LOG_FILE = join(homedir(), ".pi", "agent", "you-should-know", "checks.jsonl");
const WIDGET = "you-should-know";
const DEBUG = !!process.env.YSK_DEBUG;

// ---- herdr subagent relay ----
// A herdr child gets PI_SUBAGENT_ACTIVITY_FILE=<parentSessionDir>/artifacts/<parentSessionId>/subagent-activity/<id>.json
// (pi-herdr-subagents activity.ts getSubagentActivityFile). The child drops notes into a sibling inbox;
// the parent watches its own <sessionDir>/artifacts/<sessionId>/you-should-know-inbox/ and shows them.
const INBOX = "you-should-know-inbox";
const CHILD_ACTIVITY = process.env.PI_SUBAGENT_ACTIVITY_FILE?.trim();
const CHILD_INBOX = CHILD_ACTIVITY ? join(dirname(dirname(CHILD_ACTIVITY)), INBOX) : undefined;
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
function loadState(): State {
	const d: State = { enabled: true, seen: [], known: [], ignoredInARow: 0, skip: 0 };
	try {
		if (existsSync(STATE_FILE)) return { ...d, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
	} catch {}
	return d;
}
function saveState(s: State) {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
	} catch {}
}
function log(entry: Record<string, unknown>) {
	try {
		mkdirSync(dirname(LOG_FILE), { recursive: true });
		appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
	} catch {}
}

// ---- output parsing (the CC mod's Cr()) ----
type Tag = "You should know" | "Heads up";
type Note = { line: string; tag: Tag; explanation?: string; from?: string; shownAt: number; promptsSurvived: number; countedIgnored?: boolean };
type Parsed = { kind: "none" } | { kind: "parse_failed" } | { kind: "line"; line: string; tag: Tag; explanation?: string };
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
	let explanation: string | undefined;
	if (ei !== -1) {
		const first = strip(lines[ei]).replace(/^explain\s*:\s*/i, "");
		explanation = [first, ...lines.slice(ei + 1)].join("\n").trim() || undefined;
	}
	return { kind: "line", line, tag, explanation };
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
	let inFlight: AbortController | undefined;
	let promptCounter = 0; // stands in for CC's turnId staleness check
	let checks = 0;

	const pickModel = (ctx: ExtensionContext) => {
		const o = process.env.YSK_MODEL; // optional override: provider/model-id
		if (o && o.includes("/")) {
			const i = o.indexOf("/");
			const m = ctx.modelRegistry.find(o.slice(0, i), o.slice(i + 1));
			if (m) return m;
		}
		return ctx.model; // CC uses the main session's model (JR() -> mainLoopModel)
	};

	const render = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
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
	pi.on("before_provider_request", (e) => {
		if (e.payload && typeof e.payload === "object") mainPayload = e.payload as Record<string, unknown>;
	});

	/** Send the fork as the main request with only its message list swapped in. */
	const alignWithMain = (forked: unknown): unknown => {
		const main = mainPayload;
		if (!main || !forked || typeof forked !== "object") return undefined;
		const f = forked as Record<string, unknown>;
		if (main["model"] !== f["model"]) return undefined; // a different model has its own cache
		const key = Array.isArray(f["messages"]) ? "messages" : Array.isArray(f["input"]) ? "input" : undefined;
		if (!key || !Array.isArray(main[key])) return undefined;
		return { ...main, [key]: key === "messages" ? markBeforePrompt(f[key] as any[]) : f[key] };
	};

	/**
	 * Claude Code's model.fork passes skipCacheWrite, which moves the message
	 * cache marker from the fork's own prompt back to the message before it
	 * (IWt in the 2.1.288 binary: `Se=ke(e.length-1); if(r) Se=ke(Se-1)`).
	 * The fork then reads the shared prefix without paying to cache its ~8k
	 * token detect prompt, which no later request will ever reuse.
	 */
	const markBeforePrompt = (messages: any[]): any[] => {
		const markable = (b: any) => b && typeof b === "object" && b.type !== "thinking" && b.type !== "redacted_thinking";
		const unmark = (m: any) =>
			Array.isArray(m?.content) ? { ...m, content: m.content.map(({ cache_control: _drop, ...b }: any) => b) } : m;
		if (messages.length < 2) return messages;
		const out = messages.map((m, i) => (i === messages.length - 1 ? unmark(m) : m));
		for (let i = out.length - 2; i >= 0; i--) {
			const content = out[i]?.content;
			if (!Array.isArray(content)) continue;
			const at = content.findLastIndex(markable);
			if (at < 0) continue;
			const blocks = content.slice();
			blocks[at] = { ...blocks[at], cache_control: { type: "ephemeral" } };
			out[i] = { ...out[i], content: blocks };
			break;
		}
		return out;
	};

	function relayToParent(n: { line: string; tag: Tag; explanation?: string; from: string }) {
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
	let inboxTimer: ReturnType<typeof setInterval> | undefined;
	const inboxDir = (ctx: ExtensionContext) =>
		join(ctx.sessionManager.getSessionDir(), "artifacts", ctx.sessionManager.getSessionId(), INBOX);
	function drainInbox(ctx: ExtensionContext) {
		const dir = inboxDir(ctx);
		if (!existsSync(dir)) return;
		let added = false;
		for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
			const path = join(dir, f);
			try {
				const n = JSON.parse(readFileSync(path, "utf8"));
				unlinkSync(path);
				if (!n?.line || !state.enabled) continue;
				notes.push({ line: n.line, tag: n.tag === "Heads up" ? "Heads up" : "You should know", explanation: n.explanation, from: n.from, shownAt: Date.now(), promptsSurvived: 0 });
				while (notes.length > MAX_NOTES) log({ event: "overflow_dropped", line: notes.shift()!.line });
				log({ event: "relayed_in", from: n.from, line: n.line });
				added = true;
			} catch {}
		}
		if (added) render(ctx);
	}

	pi.on("session_start", (_e, ctx) => {
		state = loadState();
		notes = [];
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

	// A note that survives PROMPTS_SURVIVED user prompts unanswered counts as ignored (for backoff),
	// but stays on screen so notes can pile up until you answer or dismiss them.
	pi.on("input", (e) => {
		if (e.source === "extension") return;
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
							relayToParent({ line: p.line, tag: p.tag, explanation, from: CHILD_NAME });
							outcome = "relayed";
							return;
						}
						notes.push({ line: p.line, tag: p.tag, explanation: p.explanation, shownAt: Date.now(), promptsSurvived: 0 });
						while (notes.length > MAX_NOTES) log({ event: "overflow_dropped", line: notes.shift()!.line });
						render(ctx);
					}
				}
			} catch (err) {
				outcome = ac.signal.aborted ? "aborted" : "error";
				extra.error = String(err);
			} finally {
				if (inFlight === ac) inFlight = undefined;
				log({ event: "check", step, outcome, ms: Date.now() - t0, ...extra });
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
			const choice = await ctx.ui.custom<string>((_tui, theme, _kb, done) => {
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

	// CC's un(): quote the note into the main session.
	function chatInMain(n: Note, explanation?: string) {
		const body = [`${n.tag}${n.from ? ` (from subagent ${n.from})` : ""} \u00b7 ${n.line}`, ...(explanation ? ["", explanation] : [])]
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
		else if (k === "2") state.known = [...state.known.filter((x) => norm(x) !== norm(n.line)), n.line].slice(-HISTORY_MAX);
		else if (k === "3") chatInMain(n, n.explanation);
		saveState(state);
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
		description: "You should know: respond to the current note (/ysk on|off|status)",
		handler: async (args, ctx) => respond(ctx, args?.trim() || undefined),
	});
	pi.registerShortcut("alt+shift+y", { description: "You should know: respond to the current note", handler: (ctx) => respond(ctx) });
	pi.registerShortcut("alt+x", { description: "You should know: dismiss the top note", handler: (ctx) => quickDismiss(ctx) });
}
