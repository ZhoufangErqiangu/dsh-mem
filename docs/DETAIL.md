# Project memory

`@local/dsh-memory` gives a DSH agent a durable place to write notes to itself, and a cheap way to read them back in a later session. It mirrors the useful half of Claude Code's memory system: a human-editable index of agent-authored notes that is loaded once per session, with the note bodies fetched only when they matter.

## What it adds to a session

- One injected context message per session (and again after compaction) containing the project's memory index, bounded by line and byte budgets.
- Three model-facing tools: `memory_write`, `memory_read`, and `memory_search`.
- No system-prompt section, no per-turn injection, and no extra model calls.

## Where memories live

Each project gets a directory under the harness home:

```text
<DSH_HOME or ~/.dsh>/memory/<project-basename>-<root hash>/
├── MEMORY.md       # index: one line per memory
├── testing.md      # one memory per file
└── release-flow.md
```

The project root is the nearest ancestor holding `.git`, matching how DSH scopes workspace instructions. Files are plain markdown and never appear in `git status`; edit or delete them by hand at any time, and the next session reconciles the index automatically.

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
- **`workspace-write` cannot write these files.** The store is written by the plugin, outside the sandboxed `ctx.fs` fence; the model's own `write`/`edit` tools cannot reach it, which is why `memory_write` exists.

## Verification

`node --test tests/*.test.js` covers the store, the path fence, index reconciliation, budgeting, and the pre-step injection contract.

At runtime, create a memory in one session and ask for it in a new session; this is described in the repository README.
