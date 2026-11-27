# Project memory

`@local/dsh-memory` gives a DSH agent a durable place to write notes to itself, and a cheap way to read them back in a later session. It mirrors the useful half of Claude Code's memory system: a human-editable index of agent-authored notes that is loaded once per session, with the note bodies fetched only when they matter.

## What it adds to a session

- One injected context message per session (and again after compaction) containing the project's memory index, bounded by line and byte budgets.
- Three model-facing tools: `memory_write`, `memory_read`, and `memory_search`.
- No system-prompt section, no per-turn injection, and no extra model calls.
- A write made in the current session does not re-inject the whole index: its tool result already carries the new index line. A change from outside the session, or a compaction that summarizes the old block away, still injects.
- With the Client half installed, each injection renders as its own expandable Chat row ("Project memory · 1 saved") at group-tree position `turn`, instead of being folded into the Turn's process disclosure. The row claims the event exclusively, so the built-in context classifier never also sees it.

## Where memories live

Each project gets a directory under the harness home:

```text
<DSH_HOME or ~/.dsh>/memory/<project-basename>-<root hash>/
├── MEMORY.md       # index: one line per memory
├── testing.md      # one memory per file
└── release-flow.md
```

The project root is the nearest ancestor holding `.git`, matching how DSH scopes workspace instructions. Files are plain markdown and never appear in `git status`; edit or delete them by hand at any time, and the next session reconciles the index automatically.

## The management panel

`/memory` in the composer opens a management panel: the index on the left, the
selected note's body in an editor on the right, with **New**, **Save**, and
**Delete**. Saving writes through the same store functions the tools use, so a
note edited in the panel is immediately visible to `memory_read`,
`memory_search`, and the next session's index.

The panel reaches the Host through one owner-only exact Fetch route,
`POST /api/memory`. The route resolves the calling session's live agent, derives
its project root and memory directory from that session's working directory —
never from the request body — and then performs `list`, `read`, `save`, or
`delete`. Connection's `/api` handler admits the browser peer first and exact
routes are owner-only, so no other principal reaches the store. A request for an
unknown session answers `no-session`; a malformed body answers `bad-request`.

The panel never acknowledges a write for the agent's session, which is
deliberate: a change made in the UI is an outside change from the agent's point
of view, and the next pre-step injects the updated index.

## Tools

| Tool | Arguments | Behavior |
|---|---|---|
| `memory_write` | `title`, `content`, optional `file`, optional `summary` | Writes the note and upserts its index line atomically. Reusing the same file name updates that note. |
| `memory_read` | `file` | Returns the note body, bounded by `maxTopicBytes`. |
| `memory_search` | `query`, optional `limit` | Case-insensitive line search; every whitespace-separated term must appear on the same line. Returns file, line number, and text. |

The index injection also tells the agent when saving is appropriate and that notes are reference material rather than instructions.

## Configuration

```yaml
- id: memory
  name: '@local/dsh-memory'
  config:
    maxIndexLines: 200
    maxIndexBytes: 25000
    maxTopicBytes: 65536
    maxSearchResults: 20
    maxSearchBytes: 4194304
```

Every field is optional. The index defaults match Claude Code's `MEMORY.md` budget (200 lines or 25 KiB, whichever comes first); broader notes are dropped before the most recent ones.

The harness home is process policy (`DSH_HOME`), not row configuration.

## Limitations

- **No semantic recall.** Search is literal, line-level matching. There are no embeddings and no model call.
- **One flat project scope.** There is no user-global memory and no path-scoped rule tree; the nearest `.git` ancestor defines the scope.
- **No automatic curation.** Nothing consolidates, deduplicates, or expires notes. The agent writes them; a human or a future plugin manages them.
- **No watcher.** The index is recomposed at the start of each turn, so an external edit becomes visible on the next turn, not immediately.
- **The panel's delete confirmation is the browser's native `window.confirm`**, and the dialog does not trap Tab focus; Escape and the backdrop close it.
- **`workspace-write` cannot write these files.** The store is written by the plugin, outside the sandboxed `ctx.fs` fence; the model's own `write`/`edit` tools cannot reach it, which is why `memory_write` exists.

## Verification

Sources are TypeScript under `src/` and are built with tsdown into `lib/` (ESM host bundle plus the browser client factory). The package exports point at `lib/`, so run `npm run build` before installing or reloading the plugin from a checkout.

`npm run typecheck` checks the host half, the client half, and the tests. `npm test` runs `node --test tests/*.test.ts` (Node's native type stripping) and covers the store, the path fence, index reconciliation, budgeting, and the pre-step injection contract.

At runtime, create a memory in one session and ask for it in a new session; this is described in the repository README.
