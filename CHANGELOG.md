# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-31

First public release.

### Added

- `/btw <question>` — ask a side question without disturbing the running agent. Works while the
  main agent is streaming.
- Non-modal panel above the editor that never takes focus, so the main editor keeps accepting
  input during a side question.
- Opt-in panel keys (`tab` to enter): scroll, browse earlier questions, copy, clear history, fork,
  close.
- `f` branches the conversation in the same terminal and seeds the branch with the side question;
  `/btw` inside a branch returns to the original session.
- Side answers are stored as a `btw` custom entry: visible in the transcript, never sent to the
  model.
- Tool-call markup written as text (DSML, `<function_calls>`, `<tool_use>`) is stripped and replaced
  with a note, matching Claude Code's behaviour.
- `ctrl+shift+b` / `f2` to close the panel.

### Fixed

- Typing a normal prompt whose first character matched a panel key (for example `fix the bug`) no
  longer triggers a fork or clears history.
- Side questions could answer the previous user message when the transcript ended in a user turn;
  a closing assistant turn now keeps the question separate.
- Forking no longer crashes Pi by touching a stale extension context after the session switch.
