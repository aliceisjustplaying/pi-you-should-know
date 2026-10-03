# pi-you-should-know (private)

A port of Claude Code's `cc-plugin-you-should-know` mod (v2.1.287) to pi.
Every sixth step of a run it forks the live conversation, appends Claude Code's
detect prompt and asks whether there is something you should know but probably
missed. Most of the time the answer is `learn: none`; otherwise a note appears
above the editor. Answer with `/ysk` (or alt+shift+y).

**Not licensed for reuse.** `detect-prompt.md` and several constants are copied
from Anthropic's Claude Code binary. Keep this repository private.

The fork reuses the main conversation's prompt cache the way Claude Code's
`model.fork` does: it sends the main request's own payload with only the
messages swapped in, and moves the cache marker off its own prompt
(`skipCacheWrite`). Each check is logged to
`~/.pi/agent/you-should-know/checks.jsonl`, with the provider's usage.

    pi install git:github.com/aliceisjustplaying/pi-you-should-know
