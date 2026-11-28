# Project memory

`@local/dsh-memory` gives a DSH agent a durable place to write notes to itself, and a cheap way to read them back in a later session. It mirrors the useful half of Claude Code's memory system: a human-editable index of agent-authored notes that is loaded once per session, with the note bodies fetched only when they matter. A second, smaller user-global layer holds cross-project preferences.

## What it adds to a session

- One injected context message per session (and again after compaction) containing the project's memory index, preceded by the user-global index when that layer has notes. Each layer has its own line and byte budget.
- Eight model-facing tools: `memory_write`, `memory_read`, `memory_search`, `memory_delete`, `memory_audit`, `memory_sweep`, `memory_restore`, and `memory_dream`. The write, read, search, delete, and restore tools take an optional `scope: 'project' | 'global'`; the audit, sweep, and dream tools remain project-only.
- No system-prompt section and no per-turn injection. The normal path makes no model call; Auto Dream is opt-in and uses one child turn when it runs.
- A write made in the current session does not re-inject the whole index: its tool result already carries the new index line. A change from outside the session, including a change to the global layer, or a compaction that summarizes the old block away, still injects.
- With the Client half installed, each injection renders as its own expandable Chat row ("Project memory · 1 saved", or "Memory" when a global section is present), instead of being folded into the Turn's process disclosure. The row claims the event exclusively, so the built-in context classifier never also sees it.

## Where memories live

Each project gets a directory under the harness home, and the user gets one global directory beside the projects:

```text
<DSH_HOME or ~/.dsh>/memory/
├── global/                 # user-global, shared by every project
│   ├── MEMORY.md
│   ├── preferences.md
│   └── archive/
└── <project-basename>-<root hash>/
    ├── MEMORY.md           # index: one line per memory
    ├── testing.md          # one memory per file
    ├── release-flow.md
    ├── archive/            # soft-deleted notes; never indexed or searched
    │   ├── .manifest.json  # archive name -> exact original file name
    │   └── ...
    ├── .state.json         # Auto Dream clock (sessions, last success/attempt)
    ├── .store.lock         # short-lived index-write lock
    └── .dream.lock         # long-lived curation-session lock
```

The project root is the nearest ancestor holding `.git`, matching how DSH scopes workspace instructions. The global directory is named `global` without a hash; project keys always end in a root hash, so the two cannot collide. Files are plain markdown and never appear in `git status`; edit or delete them by hand at any time, and the next session reconciles the index automatically. Newly created memory directories use mode `0700` and note files use `0600` (ignored where the platform has no POSIX modes); existing files are not forcibly chmodded.

## The management panel

`/memory` in the composer opens a management panel: a **Project / Global**
switch, the selected layer's index on the left, the note body in an editor on the
right, with **New**, **Save**, **Archive**, **Delete permanently**, and
**Tidy**. **Tidy** is shown on the project tab only; it first shows the audit
report and then runs the deterministic sweep on confirmation, including the
archive retention report. Saving writes
through the same store functions the tools use, so a note edited in the panel is
immediately visible to `memory_read`, `memory_search`, and the next session's
index. Archive moves the note under that layer's `archive/`; permanent deletion
requires a second confirmation, and the global confirmation says that every
project will stop seeing the note.

The panel reaches the Host through one owner-only exact Fetch route,
`POST /api/memory`. The route resolves the calling session's live agent, takes an
optional `scope` (`project` by default), derives the project root and directory
from that session's working directory for project scope, and uses the fixed
`$DSH_HOME/memory/global/` directory for global scope. It then performs `list`,
`read`, `save`, `delete`, `audit`, `sweep`, or `restore`. `audit` and `sweep`
answer `unsupported-scope` for the global layer, and a disabled global layer
answers `global-disabled`. Connection's `/api` handler admits the browser peer
first and exact routes are owner-only, so no other principal reaches the store. A
request for an unknown session answers `no-session`; a malformed body answers
`bad-request`.

The panel never acknowledges a write for the agent's session, which is
deliberate: a change made in the UI is an outside change from the agent's point
of view, and the next pre-step injects the updated index.

## Tools

| Tool | Arguments | Behavior |
|---|---|---|
| `memory_write` | `title`, `content`, optional `file`, optional `summary`, optional `scope` | Writes the note and upserts its index line atomically. Reusing the same file name updates that note. Defaults to the project layer; `scope: 'global'` writes a cross-project preference. |
| `memory_read` | `file`, optional `scope` | Returns the note body, bounded by `maxTopicBytes`. Reads only the selected layer; a missing file is an explicit error, never a fallback to the other layer. |
| `memory_search` | `query`, optional `limit`, optional `scope` | Case-insensitive line search; every whitespace-separated term must appear on the same line. By default searches project memory first and then global memory when the project result leaves room; every match carries its scope. |
| `memory_delete` | `file`, optional `permanent`, optional `scope` | Moves the note to that layer's `archive/` and drops its index line. `permanent: true` deletes the file instead. Defaults to the project layer. |
| `memory_audit` | optional `staleDays`, `threshold`, `limit`, `verbose` | Project-only read-only report: duplicate clusters (identical, near, same-title), stale notes, oversized notes, and index budget pressure. Near-duplicates are reported, never merged. |
| `memory_sweep` | optional `dryRun`, `archiveOverflow` | Project-only deterministic cleanup: reconcile the index, archive empty and byte-identical duplicate notes, remove old `.tmp` files, and permanently delete archived notes older than `archiveMaxAgeDays`. `dryRun` defaults to true; `archiveOverflow` can archive the oldest notes until the index fits 80% of its budget. |
| `memory_restore` | `archive`, optional `scope` | Move one generated archive file back to that layer's top level and rebuild the index. A name collision is refused. |
| `memory_dream` | none | Project-only: run one explicit curation pass immediately in a restricted child agent. Uses one model turn. The automatic pass is opt-in; this is its manual equivalent. |

The index injection also tells the agent when saving is appropriate and that notes are reference material rather than instructions. When the rendered project index is over budget, it points at `memory_audit` and `memory_delete`. Global notes are framed as cross-project and subordinate to project notes on conflict. `memory_write` also returns up to three similar existing notes so duplicates can be caught at write time.

## Configuration

```yaml
- id: memory
  name: '@local/dsh-memory'
  config:
    maxIndexLines: 200
    maxIndexBytes: 25000
    globalMemoryEnabled: true
    maxGlobalIndexLines: 40
    maxGlobalIndexBytes: 6000
    maxTopicBytes: 65536
    maxSearchResults: 20
    maxSearchBytes: 4194304
    staleDays: 90
    duplicateThreshold: 0.6
    oversizeBytes: 16384
    maxAuditNotes: 200
    archiveOverflow: false
    archiveMaxAgeDays: 30
    curationEnabled: false
    curationMinHours: 24
    curationMinSessions: 5
    curationRetryHours: 1
    curationTimeoutMs: 600000
    curationProvider: ''
    curationModel: ''
    curationMaxTokens: 4096
```

Every field is optional. The project index defaults match Claude Code's `MEMORY.md` budget (200 lines or 25 KiB, whichever comes first); broader notes are dropped before the most recent ones. The user-global layer has a separate smaller budget (40 lines or 6000 bytes by default); when it has no notes, no global section is rendered and its budget is unused. Archived notes are kept for `archiveMaxAgeDays` (default 30); `0` keeps them forever.

The harness home is process policy (`DSH_HOME`), not row configuration.

## Limitations

- **No semantic recall.** Search is literal, line-level matching. There are no embeddings and no model call.
- **Two scopes, not a hierarchy.** Project memory and one user-global layer; there is no team/organization layer and no path-scoped rule tree. Global notes are reference material and never override project notes, instructions, or system messages.
- **Global memory has no curation yet.** `memory_audit`, `memory_sweep`, and `memory_dream` are project-only, and the panel's Tidy action is hidden on the global tab. Global notes can still be created, edited, archived, permanently deleted, restored, and searched.
- **No read fallback.** `memory_read` and `memory_delete` act on the selected scope only; a missing file returns an explicit error that names the scope and suggests `scope: 'global'` when relevant.
- **Auto Dream is opt-in.** When `curationEnabled` is true and both the wall-clock and session gates pass, one restricted child agent consolidates project notes; `memory_dream` runs the same pass on demand. It is off by default, uses one model turn, has a project lock and timeout, and never permanently deletes.
- **Deterministic cleanup is conservative.** `memory_sweep` archives only empty notes, byte-identical duplicates, and (when enabled) the oldest notes over budget. Near-duplicates and stale notes remain report-only. Archived notes older than `archiveMaxAgeDays` (default 30, `0` keeps them forever) are permanently removed only when the sweep is applied, not during a dry run or an Auto Dream pass.
- **Global archive retention is not exposed yet.** The global layer has no sweep, so `archiveMaxAgeDays` currently prunes project archives only; `global/archive/` must be cleaned manually.
- **No watcher.** The index is recomposed at the start of each turn, so an external edit — in either layer — becomes visible on the next turn, not immediately.
- **The panel's delete confirmation is the browser's native `window.confirm`**, and the dialog does not trap Tab focus; Escape and the backdrop close it.
- **`workspace-write` cannot write these files.** The store is written by the plugin, outside the sandboxed `ctx.fs` fence; the model's own `write`/`edit` tools cannot reach it, which is why `memory_write` exists.

## Verification

Sources are TypeScript under `src/` and are built with tsdown into `lib/` (ESM host bundle plus the browser client factory). The package exports point at `lib/`, so run `npm run build` before installing or reloading the plugin from a checkout.

`npm run typecheck` checks the host half, the client half, and the tests. `npm test` runs `node --test tests/*.test.ts` (Node's native type stripping) and covers the store, the path fence, index reconciliation, budgeting, the store and curation locks, soft delete and archiving, restore, deterministic sweep including archive retention, write-time similarity hints, audit duplicate/stale/oversized detection, the Auto Dream clock and gate, the restricted curation child, the pre-step injection contract, UTF-8 boundary reads, the index cache, private file modes, and the user-global scope (paths, dual-section injection, scope-aware read/search/delete, write acknowledgement, disabled mode, and the panel route).

At runtime, create a memory in one session and ask for it in a new session; this is described in the repository README.
