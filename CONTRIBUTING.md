# Contributing

Thanks for taking a look. This is a single-file Pi extension, so the loop is short.

## Setup

```bash
git clone https://github.com/Syauqi-N/pi-btw-quiet
cd pi-btw-quiet
npm install
```

## Develop

```bash
npm run check                # typecheck (tsc --noEmit)
pi -e ./extensions/btw.ts    # load this working copy into Pi
```

Inside Pi, edit `extensions/btw.ts` and run `/reload` to pick up changes without restarting. Running
Pi needs Node.js 22.19 or newer.

## Test by hand

There is no automated test harness yet, so verify the behaviours that matter:

1. **Non-blocking.** Start a long task, run `/btw <question>`, and confirm the main agent keeps
   producing output and the editor still accepts typing. With the main agent idle, a prompt submitted
   while a side answer streams must start right away.
2. **No stolen keys.** With a panel open, type a prompt beginning with `f` or `x`. It must land in
   the editor, not trigger fork or clear.
3. **Abort scope.** Press `esc` while the main agent streams and a panel is open. Only the panel
   should close; the main agent keeps running.
4. **Branch.** `tab` then `f` should move you into a new session named `btw:<origin-id> · <question>`,
   with the side answer in the conversation and in model context. `/btw` returns you to the original,
   with its transcript intact.
5. **No context pollution.** After a side question, the next main turn must not contain the side
   question text.
6. **Fresh transcript.** Close the panel, let the main agent finish another turn, and ask again. The
   side agent must know about that turn.

## Guidelines

- Keep it one file unless there is a strong reason to split.
- Never take focus from the editor. The panel is a widget, not a modal.
- Any key the panel handles must be opt-in, so typing is never intercepted.
- Abort only what you started; never touch the main agent's controller.
- If you add behaviour, add a CHANGELOG entry under `## [Unreleased]`.

## Reporting bugs

Include your Pi version (`pi --version`), the model/provider you used, and what you expected versus
what happened. A screenshot of the panel helps.
