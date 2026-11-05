# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Requires Node.js 22.19 or newer, matching Pi 1.4.
- Closing the panel now ends its side thread. The next `/btw` starts from the current transcript.

### Fixed

- A prompt submitted while a side answer streamed was held until that answer finished when the main
  agent was idle. It now starts right away; follow-up `/btw` questions still run one at a time.
- `/btw` inside a branch opened an empty session and left a stray file in the project directory. It
  now returns to the session the branch came from.
- The side agent no longer answers from an old copy of the transcript after the panel was closed.
- Models from providers registered by another extension failed with `No API key found`.
- A failure while creating the side session is now shown in the panel.

## [0.3.0] - 2026-11-04

### Added

- **Pin the side agent's model** with `~/.pi/agent/btw.json`:
  `{"model": "openai/gpt-5.2", "thinking": "low"}`. The file is re-read before every ask, so
  edits apply without a restart. A pinned model is never re-synced to the main session's; omit
  `model` (or delete the file) to follow the main session again. A broken config is reported and the
  question is dropped instead of silently falling back to another model.
- An interrupted side question now shows `stopped` instead of vanishing from the transcript.

### Changed

- Side history raised to 20 exchanges, with the oldest dropped beyond that.
- `/btw` records an exchange that was stopped mid-answer, so closing the panel early no longer
  loses the question from the transcript.

### Fixed

- A transcript that fails to seed now warns instead of silently answering with no context at all.
- `btw.json` containing a JSON array or other non-object value is rejected rather than accepted.
- A side question that errors no longer leaves the panel spinning on an empty answer.

## [0.2.0] - 2026-10-31

### Changed

- **The side agent can now read the repo.** It runs in its own in-memory `AgentSession` seeded with
  the main transcript, restricted to `read`, `grep`, `find` and `ls`, instead of a single tool-less
  model call. This follows the approach of `L2ncE/pi-btw`; see Credits in the README.
- Side history raised to 10 exchanges and kept per side session.
- Renamed to `pi-btw-quiet` to avoid colliding with the existing `pi-btw`.

### Fixed

- The side session is disposed on `session_start`, so `/new` and `/resume` no longer answer from a
  previous session's transcript.
- Side model switches use `SettingsManager.inMemory()` and never touch the user's `settings.json`.

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
