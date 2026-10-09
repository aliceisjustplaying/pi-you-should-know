# pi-you-should-know

A Pi extension that occasionally taps you on the shoulder: "heads up, you probably missed this."

While an agent works, a second copy of the conversation is asked one question every few steps: is there something the user should know but probably didn't notice? Usually the answer is no and you see nothing. When the answer is yes, a short note appears above the editor, with a pointer to where it came from (a file and line, a test, a command).

It's a port of the "you should know" plugin built into Claude Code.

## Using it

- A note shows up above the editor, like `✦ Heads up · The agent loosened the test threshold from 0.8 to 0.65.`
- `/ysk` or alt+shift+y: open the top note. You can learn more about it, mark it as something you knew, send it to the agent or dismiss it.
- alt+x: dismiss the top note.
- `/ysk off`, `/ysk on`, `/ysk status`: turn it off and on, or see how many checks it has run.

If you keep ignoring notes, it checks less often. Answering any note resets that.

Open notes and answer history are saved with the Pi session. Knew and Undo feedback is saved under `~/.pi/agent/you-should-know/` (or your `PI_CODING_AGENT_DIR`), so separate Pi sessions cannot overwrite one another’s feedback. Relayed child notes stay in the inbox until they appear in the parent’s saved conversation.

## In RPC clients

Without Pi's terminal UI (for example in T3 Code), each note is sent once as a notification in the form `[ysk:<id>] <tag> · <line> (<evidence>)`, followed by its explanation, so the client can show and answer it. The client reports each answer back with `/ysk answer <id> <action>` (`knew`, `dismiss`, `learn` or `send`); that removes the note silently and, for `knew`, remembers it as something you know. Notes are sent immediately, including between runs. T3 Code shows them in its heads-up band; `/ysk` points to those controls. Notes and answers survive a Pi restart. The client can undo an answer with `/ysk answer <id> undo`, which also removes a previous `knew` answer. Unanswered notes reduce the check frequency in RPC clients too.

## With herdr subagents

When the extension runs inside a [pi-herdr-subagents](https://github.com/aliceisjustplaying/pi-herdr-subagents) subagent, its notes aren't shown in the subagent's pane. They're passed to the parent agent as a message instead, labeled with the subagent's name, so the agent that's coordinating the work can act on them.

## Side models

Optional top-level `model` and `thinking` keys in `~/.pi/agent/you-should-know/config.json` (or under `PI_CODING_AGENT_DIR`) set a general side model, independently of the main model family:

```json
{
  "model": "openai/gpt-6.1-sol",
  "thinking": "high"
}
```

Model selection priority is `YSK_MODEL` → top-level `model` → family route → the main model. `YSK_MODEL` changes only the model; it does not override thinking. Thinking uses the top-level `thinking` key when set, otherwise the family thinking default.

If no general model is set, YSK uses these family defaults, independently of the main agent's thinking level:

- GPT models → `openai-codex/gpt-6.1-sol`, high thinking.
- Claude Fable models (including versioned variants) → `anthropic/claude-opus-5-5`, medium thinking.
- Other models → the main model. Other Claude models keep their existing same-model request behavior.

Family routes remain configurable in that same file:

```json
{
  "gpt": { "model": "openai-codex/gpt-6.1-sol", "thinking": "high" },
  "fable": { "model": "anthropic/claude-opus-5-5", "thinking": "medium" }
}
```

Each model value is a registered `provider/model-id`, using that provider's credentials. Thinking accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, subject to the selected model's support. Missing fields use the defaults above. Invalid model configuration or unknown IDs fail the check rather than silently using the main model. Changes apply to the next check or explanation; `/ysk status` shows the effective model, thinking and config path.

### Fallback

An optional `fallback` object in the same file names a one-shot backup model. It runs only when the primary side request errors or throws. A successful primary response, `learn: none`, an unparseable answer, or an abort does not trigger it. The primary request is not retried. If both primary and fallback fail, the check is recorded as an error.

For example, a MiniMax primary with an OpenAI backup:

```json
{
  "model": "minimax-cn/MiniMax-M3.1-Flash-Preview",
  "thinking": "off",
  "fallback": { "model": "openai/gpt-6-luna", "thinking": "off" }
}
```

Fallback diagnostics are written to `~/.pi/agent/you-should-know/checks.jsonl` as `ysk_fallback_triggered` and `ysk_fallback_result`. `/ysk status` reports the configured fallback.

## Cost

Same-model Claude checks reuse the main request's cached prefix. A different side model still receives the conversation, but can cost more because that cache reuse is not guaranteed. Every check is logged, with token usage, to `~/.pi/agent/you-should-know/checks.jsonl`.

## Install

    pi install git:github.com/aliceisjustplaying/pi-you-should-know
