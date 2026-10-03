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

## With herdr subagents

When the extension runs inside a [pi-herdr-subagents](https://github.com/aliceisjustplaying/pi-herdr-subagents) subagent, its notes aren't shown in the subagent's pane. They're passed to the parent agent as a message instead, labeled with the subagent's name, so the agent that's coordinating the work can act on them.

## Cost

Each check reuses the conversation the main agent already cached, so it costs a fraction of a normal turn. Every check is logged, with token usage, to `~/.pi/agent/you-should-know/checks.jsonl`.

## Install

    pi install git:github.com/aliceisjustplaying/pi-you-should-know

## Keep this repo private

`detect-prompt.md` and some settings are copied from Claude Code, which belongs to Anthropic. This code isn't licensed for anyone else to use.
