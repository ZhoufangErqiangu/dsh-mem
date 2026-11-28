# Changelog

All notable changes to this plugin are recorded here. The project follows
[Semantic Versioning](https://semver.org/) and this file follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `memory_audit`: duplicate clusters (identical, near, same-title), stale and
  oversized notes, and index budget pressure; reports are bounded.
- `memory_delete`: soft delete by default, moving a note to `archive/`;
  `permanent: true` deletes it.
- `memory_sweep`: dry-run by default; archives empty notes and byte-identical
  duplicates, removes old `*.tmp` files, rewrites the index, and optionally
  archives the oldest notes until the index fits 80% of its budget.
- `memory_restore`: restores a generated archive by name and refuses collisions.
- `memory_dream` plus the opt-in Auto Dream pass: a restricted child agent
  consolidates notes after `curationMinHours` and `curationMinSessions`, guarded
  by a retry window, a per-project lock, a timeout, and a recursion guard.
- Write-time similarity hints, an over-budget curation nudge, and a panel
  "Tidy" report with an apply action.
- `archive/.manifest.json` preserves the exact original file name, including
  names that the readable archive slug would otherwise change.
- A GitHub Actions workflow running typecheck, tests, and the build on Node 24.

### Changed

- Panel delete now archives by default; permanent deletion has a separate
  confirmation.
- New memory directories use mode `0700` and note/archive/state files use
  `0600` on POSIX; existing modes are left alone.
- The reconciled index is cached for a few seconds across `agent/pre-step`
  calls, with explicit invalidation on every mutation.

### Fixed

- `memory_search` now measures its scan budget in UTF-8 bytes instead of
  JavaScript string length.
- Bounded reads no longer decode a truncated multi-byte character as U+FFFD.
- Concurrent index writes are serialized by an in-process queue plus an
  advisory `.store.lock`.

## [0.3.0] - 2026-11-27

### Changed

- Rewrote the plugin in TypeScript and switched the build to `tsdown`; `lib/`
  is generated from `src/` and is not committed.

## [0.2.0] - 2026-11-27

### Added

- `/memory` management panel backed by the owner-only `POST /api/memory` route.
- A dedicated expandable Chat row for each injected memory index.
- Write acknowledgment so a session's own `memory_write` does not re-inject the
  whole index.

## [0.1.0] - 2026-11-26

### Added

- Initial `MEMORY.md` index injection and the `memory_write`, `memory_read`, and
  `memory_search` tools.
