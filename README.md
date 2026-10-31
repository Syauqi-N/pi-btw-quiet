# pi-btw

Ask a side question in [Pi](https://pi.dev) without disturbing the agent that is currently working.

`/btw` runs a **separate model call** with your session transcript as read-only context. The main
agent keeps streaming, keeps its own turn, and is never steered, queued, aborted, or branched. The
answer appears in a small panel above the editor, and you can keep typing into the main editor the
whole time.

This is a Pi port of the behaviour of Claude Code's `/btw`, rebuilt against Pi's extension API.

```
/btw why is this test failing?
```

```
/btw kenapa test ini gagal?

  Test-nya gagal karena fixture `db` belum di-reset antar spec,
  jadi baris dari test sebelumnya masih ada saat assertion jalan.

tab to scroll · esc to close · keep typing to talk to the main agent
```

## Why

Sometimes you have a quick question mid-run: *what does this flag do, where is that helper defined,
why did we pick this approach?* Typing it into the main conversation derails the agent — it gets
steered, queued, or your prompt gets merged into the work in progress.

`/btw` gives that question its own cheap call against the same context, so the main run is untouched.

## Install

```bash
pi install npm:pi-btw
```

Or from git:

```bash
pi install git:github.com/Syauqi-N/pi-btw
```

Or try it for one session without installing:

```bash
pi -e npm:pi-btw
```

Requires Pi with extension support. `@earendil-works/pi-*` packages are supplied by the host.

## Usage

| Command | What it does |
|---|---|
| `/btw <question>` | Ask a side question. Works while the main agent is streaming. |
| `/btw` | Close the panel. Inside a btw branch, jump back to the original session. |
| `ctrl+shift+b` / `f2` | Close the panel. |

Follow-up `/btw` questions while a panel is open are appended to the same side thread, so you can
ask a chain of questions without touching the main conversation.

### Panel keys

The panel never takes focus, so typing is never stolen. Keys are **opt-in**: press `tab` first.

| Key | Action |
|---|---|
| `tab` | Enter panel key mode |
| `↑` `↓` `pgup` `pgdn` | Scroll the answer |
| `shift+←` `shift+→` | Browse earlier side questions |
| `c` | Copy the answer |
| `x` | Clear the panel's side-question history |
| `f` | Branch the conversation here (`f` for "fork") |
| `esc` | Leave key mode, then close the panel |

Keys only work while the editor is empty. If you start typing a normal prompt, every key goes to the
editor — that is deliberate, so a prompt beginning with `f` or `x` is never mistaken for a command.

### Branching

`f` branches the conversation the way Claude Code does: it creates a new session from the current
position, seeds it with the side question and answer, and **switches you into the branch** in the
same terminal. The original session is untouched.

Inside a branch, `/btw` with no question jumps back to the session you branched from. The branch is a
normal session, so it also shows up in `/resume`.

## What a side question sees

- The current session transcript (compacted view), trimmed to a character budget.
- Your question, plus any earlier questions in the same panel.

It does **not** get tools. If the model tries to write a tool call as text — DeepSeek's
`<｜｜DSML｜｜>` blocks, Anthropic's `<function_calls>`, or generic `<tool_use>` — the markup is
stripped and replaced with a note telling you to ask in the main conversation. That mirrors what
Claude Code does for the same failure mode.

Answers are stored as a `btw` custom entry: visible in the transcript, **never sent to the model**.
So side questions cost you context once (the transcript is read) but never pollute future turns.

## Design notes

- **Non-blocking.** The panel is a widget above the editor, not a modal. It never calls
  `setFocus`, so the main agent's input path is unaffected.
- **One model call per question.** No tools, no agent loop, no retries that outlive the panel.
- **Abort is scoped.** `esc` cancels only the side request. The main agent's own `esc` still works.
- **No context pollution.** Answers live in a custom entry and are filtered out of side-question
  context, so a later side question does not re-read earlier side answers.

## Development

```bash
git clone https://github.com/Syauqi-N/pi-btw
cd pi-btw
npm install
npm run check     # tsc --noEmit
pi -e ./btw.ts    # load the working copy
```

Edit `btw.ts`, then `/reload` inside Pi to pick up changes.

## License

MIT
