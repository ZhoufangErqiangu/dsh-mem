/**
 * Client half of `@local/dsh-memory`.
 *
 * Two surfaces:
 * - The injected memory index renders as its own expandable Chat row. The
 *   Definition claims the `user/message` event exclusively, so the built-in
 *   input-message classifier does not also turn it into a folded context row,
 *   and the node sits at group-tree position `turn`, outside the process
 *   disclosure.
 * - `/memory` opens a management panel over `shell.overlay`. Data comes from the
 *   owner-only `/api/memory` route, which runs the same store operations as the
 *   model's tools.
 *
 * tsdown wraps this module into `lib/client.js`: a CJS closure registered with
 * the page's module table through `window.__ModuleLoader__.load`. React comes
 * from that table; no Harness Client package is loaded as a module.
 *
 * @module @local/dsh-memory/client
 */

import * as React from 'react'
import type { AuditReport, MemoryEntry, SweepReport } from '../types.ts'
import type {
  ClientContext,
  ConversationMatch,
  ConversationNodeDefinition,
  LocaleDictionary,
  Translate,
} from './contracts.ts'

const h = React.createElement

/** Locale namespace owned by this plugin. */
const NS = 'memory'

const zh: LocaleDictionary = {
  'row.title': '项目记忆',
  'row.count': '{count} 条',
  'row.empty': '尚无条目',
  'row.show': '展开记忆索引',
  'row.hide': '收起记忆索引',
  'command.title': '记忆',
  'command.description': '查看和编辑项目记忆',
  'panel.title': '项目记忆',
  'panel.hint': '保存在 harness home 下，不进仓库；agent 通过 memory_write 写入。',
  'panel.empty': '还没有记忆',
  'panel.emptyHint': '让 agent 记一条，或在下面新建。',
  'panel.new': '新建',
  'panel.save': '保存',
  'panel.archive': '归档',
  'panel.permanent': '永久删除',
  'panel.confirmArchive': '归档「{title}」？会从索引移除，但可在 archive/ 中恢复。',
  'panel.confirmPermanent': '永久删除「{title}」？此操作不可恢复。',
  'panel.close': '关闭',
  'panel.loading': '加载中…',
  'panel.none': '从左侧选择一条记忆',
  'panel.titleLabel': '标题',
  'panel.contentLabel': '内容',
  'panel.saved': '已保存',
  'panel.archived': '已归档',
  'panel.deleted': '已永久删除',
  'panel.titlePlaceholder': '给这条记忆起个名字',
  'panel.contentPlaceholder': '写清楚学到了什么、为什么重要、下次怎么做。',
  'panel.count': '{count} 条记忆',
  'panel.tidy': '整理',
  'panel.auditTitle': '记忆整理',
  'panel.sweep': '执行清扫',
  'panel.confirmSweep': '执行清扫会归档空笔记和完全重复的笔记；若启用了 archiveOverflow，还会归档最旧笔记。是否继续？',
  'panel.back': '返回',
  'panel.report.budget': '{notes} 条笔记 · 索引 {lines}/{maxLines} 行 · {bytes}/{maxBytes} 字节',
  'panel.report.duplicates': '重复 {count} 组',
  'panel.report.stale': '过期 {count} 条',
  'panel.report.oversized': '超长 {count} 条',
  'panel.report.clean': '没有发现需要清理的内容。',
  'panel.report.overBudget': '索引仍超出预算。',
  'panel.report.sweep': '清理前 {before} 条 → 清理后 {after} 条；归档 {archived} 个，清理临时文件 {temps} 个。',
  'panel.report.indexRewritten': '索引已重写。',
}
const en: LocaleDictionary = {
  'row.title': 'Project memory',
  'row.count': '{count} saved',
  'row.empty': 'no notes yet',
  'row.show': 'Show the memory index',
  'row.hide': 'Hide the memory index',
  'command.title': 'Memory',
  'command.description': 'View and edit project memory',
  'panel.title': 'Project memory',
  'panel.hint': 'Stored under the harness home, never in the repository; the agent writes with memory_write.',
  'panel.empty': 'No memory yet',
  'panel.emptyHint': 'Ask the agent to save one, or create one below.',
  'panel.new': 'New',
  'panel.save': 'Save',
  'panel.archive': 'Archive',
  'panel.permanent': 'Delete permanently',
  'panel.confirmArchive': 'Archive "{title}"? It leaves the index but stays recoverable under archive/.',
  'panel.confirmPermanent': 'Permanently delete "{title}"? This cannot be undone.',
  'panel.close': 'Close',
  'panel.loading': 'Loading…',
  'panel.none': 'Pick a memory on the left',
  'panel.titleLabel': 'Title',
  'panel.contentLabel': 'Content',
  'panel.saved': 'Saved',
  'panel.archived': 'Archived',
  'panel.deleted': 'Permanently deleted',
  'panel.titlePlaceholder': 'Name this memory',
  'panel.contentPlaceholder': 'What was learned, why it matters, and what to do next time.',
  'panel.count': '{count} items',
  'panel.tidy': 'Tidy',
  'panel.auditTitle': 'Memory tidy',
  'panel.sweep': 'Run cleanup',
  'panel.confirmSweep': 'Cleanup archives empty notes and byte-identical duplicates; with archiveOverflow enabled it also archives the oldest notes. Continue?',
  'panel.back': 'Back',
  'panel.report.budget': '{notes} notes · index {lines}/{maxLines} lines · {bytes}/{maxBytes} bytes',
  'panel.report.duplicates': 'Duplicate groups: {count}',
  'panel.report.stale': 'Stale: {count}',
  'panel.report.oversized': 'Oversized: {count}',
  'panel.report.clean': 'Nothing needs deterministic cleanup.',
  'panel.report.overBudget': 'The index is still over budget.',
  'panel.report.sweep': '{before} → {after} notes; archived {archived}, removed {temps} temp files.',
  'panel.report.indexRewritten': 'The index was rewritten.',
}

const styles = {
  root: { margin: '2px 0 6px' },
  toggle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 6px',
    margin: '0 0 0 -6px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: '12px',
    lineHeight: '20px',
    cursor: 'pointer',
    textAlign: 'left',
  },
  dot: {
    width: '6px',
    height: '6px',
    borderRadius: '999px',
    background: 'var(--dsw-alias-state-business-primary)',
    flex: 'none',
  },
  title: { color: 'var(--dsw-alias-label-primary)' },
  meta: { color: 'var(--dsw-alias-label-caption)' },
  body: {
    margin: '4px 0 0',
    padding: '10px 12px',
    maxHeight: '280px',
    overflow: 'auto',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-markdown-code-block)',
    color: 'var(--dsw-alias-label-secondary)',
    fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, monospace)',
    fontSize: '12px',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  scrim: {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483000',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background: 'var(--dsw-alias-bg-mask, rgba(0, 0, 0, 0.45))',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    width: 'min(860px, 100%)',
    height: 'min(620px, 100%)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '12px',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.32)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '10px',
    padding: '14px 16px 10px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  heading: { margin: '0', fontSize: '14px', fontWeight: '600' },
  hint: { color: 'var(--dsw-alias-label-caption)', fontSize: '12px', flex: '1', minWidth: '0' },
  close: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '16px',
    lineHeight: '20px',
    cursor: 'pointer',
    padding: '0 4px',
  },
  main: { display: 'flex', flex: '1', minHeight: '0' },
  list: {
    width: '260px',
    flex: 'none',
    borderRight: '1px solid var(--dsw-alias-border-l1)',
    overflow: 'auto',
    padding: '6px',
    margin: '0',
    listStyle: 'none',
  },
  item: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    padding: '6px 8px',
    cursor: 'pointer',
  },
  itemActive: { background: 'var(--dsw-alias-interactive-bg-hover)' },
  itemTitle: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
  itemSummary: {
    fontSize: '11px',
    color: 'var(--dsw-alias-label-caption)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  editor: { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 16px' },
  label: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: '13px',
    padding: '6px 8px',
  },
  textarea: {
    flex: '1',
    width: '100%',
    boxSizing: 'border-box',
    minHeight: '160px',
    resize: 'none',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    background: 'var(--dsw-alias-markdown-code-block)',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, monospace)',
    fontSize: '12px',
    lineHeight: '1.5',
    padding: '8px 10px',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    padding: '10px 16px 14px',
    borderTop: '1px solid var(--dsw-alias-border-l1)',
  },
  status: { flex: '1', fontSize: '12px', color: 'var(--dsw-alias-label-caption)' },
  error: { flex: '1', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
  button: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: '12px',
    padding: '5px 12px',
    cursor: 'pointer',
  },
  primary: {
    border: '1px solid transparent',
    borderRadius: '6px',
    background: 'var(--dsw-alias-state-business-primary)',
    color: 'var(--dsw-alias-bg-base)',
    font: 'inherit',
    fontSize: '12px',
    padding: '5px 12px',
    cursor: 'pointer',
  },
  danger: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--dsw-alias-state-error-primary)',
    font: 'inherit',
    fontSize: '12px',
    padding: '5px 12px',
    cursor: 'pointer',
  },
  empty: { padding: '24px', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' },
} satisfies Record<string, React.CSSProperties>

/** Extract the plain text of one message content list. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      block !== null
      && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map(block => block.text)
    .join('\n')
}

/** Durable state of one rendered memory row. */
interface MemoryRowState {
  seq: number
  text: string
  count: number
}

interface MemoryRowProps {
  node: { data?: Partial<MemoryRowState> }
  t: Translate
}

/** One visible, expandable row for one injected memory index. */
function MemoryRow({ node, t }: MemoryRowProps): React.ReactElement {
  const data = node.data ?? {}
  const [open, setOpen] = React.useState(false)
  const text = typeof data.text === 'string' ? data.text : ''
  const count = typeof data.count === 'number' && Number.isInteger(data.count) ? data.count : 0
  const label = count === 0 ? t('row.empty') : t('row.count', { count })
  return h('div', { style: styles.root, 'data-memory-row': 'true' },
    h('button', {
      type: 'button',
      onClick: () => setOpen(value => !value),
      'aria-expanded': open,
      'aria-label': open ? t('row.hide') : t('row.show'),
      title: open ? t('row.hide') : t('row.show'),
      style: styles.toggle,
    },
      h('span', { 'aria-hidden': true, style: styles.dot }),
      h('span', { style: styles.title }, t('row.title')),
      h('span', { style: styles.meta }, `· ${label}`),
      h('span', { 'aria-hidden': true, style: styles.meta }, open ? '▾' : '▸'),
    ),
    open ? h('pre', { style: styles.body }, text) : null,
  )
}

/** Definition turning a memory injection into its own Chat row. */
const memoryMessageDefinition: ConversationNodeDefinition<MemoryRowState> = {
  kind: 'memory-message',
  target: 'chat',
  match(event) {
    if (event.type !== 'user/message') return null
    const source = event.data?.source
    if (source === null || typeof source !== 'object' || source.kind !== NS) return null
    return { id: String(event.data.id), role: 'start', exclusive: true }
  },
  start(_context, match: ConversationMatch) {
    const event = match.event
    const source = event.data.source
    return {
      seq: event.seq,
      text: textOf(event.data.content),
      count: typeof source?.entryCount === 'number' && Number.isInteger(source.entryCount) ? source.entryCount : 0,
    }
  },
  update: context => context.state,
  buildViewNode(context) {
    const state = context.state
    if (state === undefined) return null
    return {
      key: context.key,
      kind: 'memory-message',
      id: context.id,
      target: 'chat',
      anchorSeq: state.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      groupTree: 'turn',
      data: state,
    }
  },
}

/** Panel visibility shared by the `/memory` action and the overlay entry. */
interface PanelState {
  open: boolean
  sessionId: string | undefined
}

interface PanelStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): PanelState
  open(sessionId: string | undefined): void
  close(): void
}

function createPanelStore(): PanelStore {
  let state: PanelState = { open: false, sessionId: undefined }
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => state,
    open(sessionId) {
      state = { open: true, sessionId }
      emit()
    },
    close() {
      state = { open: false, sessionId: state.sessionId }
      emit()
    },
  }
}

interface ListValue {
  projectRoot: string
  dir: string
  entries: MemoryEntry[]
}

interface ReadValue {
  file: string
  path: string
  content: string
  bytes: number
  truncated: boolean
}

interface SaveValue {
  entry: MemoryEntry
  entries: MemoryEntry[]
  line: string
}

interface DeleteValue {
  entries: MemoryEntry[]
  archived: boolean
  archivePath: string
}

type ReportState =
  | { kind: 'audit'; data: AuditReport }
  | { kind: 'sweep'; data: SweepReport }

/** Call the owner-only panel route; throws the Host's message on refusal. */
async function callMemoryApi<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(new URL('api/memory', document.baseURI), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  })
  let payload: unknown
  try {
    payload = await response.json()
  }
  catch {
    throw new Error(`memory API answered ${response.status}`)
  }
  if (payload === null || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) {
    const error = (payload as { error?: { message?: unknown } } | null)?.error
    const message = error?.message
    throw new Error(typeof message === 'string' ? message : `memory API answered ${response.status}`)
  }
  return (payload as { value: T }).value
}

interface SummaryItemProps {
  entry: MemoryEntry
  active: boolean
  onSelect: (entry: MemoryEntry) => void
}

function SummaryItem({ entry, active, onSelect }: SummaryItemProps): React.ReactElement {
  return h('li', null,
    h('button', {
      type: 'button',
      onClick: () => onSelect(entry),
      style: active ? { ...styles.item, ...styles.itemActive } : styles.item,
      title: entry.file,
    },
      h('div', { style: styles.itemTitle }, entry.title),
      entry.summary === '' ? null : h('div', { style: styles.itemSummary }, entry.summary),
    ),
  )
}

type PanelView =
  | { kind: 'none' }
  | { kind: 'new'; title: string; content: string }
  | { kind: 'edit'; file: string; title: string; content: string }

interface MemoryPanelProps {
  sessionId: string | undefined
  t: Translate
  onClose: () => void
}

/** Render the audit or sweep report as plain report lines. */
function reportLines(report: ReportState, t: Translate): string[] {
  if (report.kind === 'sweep') {
    const data = report.data
    const lines = [t('panel.report.sweep', {
      before: data.before.notes,
      after: data.after.notes,
      archived: data.archived.length,
      temps: data.removedTemps.length,
    })]
    for (const item of data.archived) lines.push(`- ${item.file} → ${item.archivePath} (${item.reason})`)
    if (data.indexRewritten) lines.push(t('panel.report.indexRewritten'))
    if (data.overBudget) lines.push(t('panel.report.overBudget'))
    return lines
  }

  const data = report.data
  const lines = [t('panel.report.budget', {
    notes: data.notes,
    lines: data.budget.usedLines,
    maxLines: data.budget.maxLines,
    bytes: data.budget.usedBytes,
    maxBytes: data.budget.maxBytes,
  })]
  if (data.duplicates.length > 0) {
    lines.push(t('panel.report.duplicates', { count: data.duplicates.length }))
    for (const group of data.duplicates) {
      lines.push(`- ${group.kind} ${Math.round(group.score * 100)}%: ${group.files.join(', ')}`)
    }
  }
  if (data.stale.length > 0) {
    lines.push(t('panel.report.stale', { count: data.stale.length }))
    for (const note of data.stale) lines.push(`- ${note.file} (${note.ageDays}d)`)
  }
  if (data.oversized.length > 0) {
    lines.push(t('panel.report.oversized', { count: data.oversized.length }))
    for (const note of data.oversized) lines.push(`- ${note.file} (${note.bytes} bytes)`)
  }
  if (data.duplicates.length === 0 && data.stale.length === 0 && data.oversized.length === 0) {
    lines.push(t('panel.report.clean'))
  }
  if (data.budget.overBudget) lines.push(t('panel.report.overBudget'))
  return lines
}

/** The management panel: list, read, edit, create, delete, and tidy. */
function MemoryPanel({ sessionId, t, onClose }: MemoryPanelProps): React.ReactElement {
  const [entries, setEntries] = React.useState<MemoryEntry[]>([])
  const [dir, setDir] = React.useState('')
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [view, setView] = React.useState<PanelView>({ kind: 'none' })
  const [report, setReport] = React.useState<ReportState | null>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)

  const load = React.useCallback(async () => {
    setStatus('loading')
    try {
      const value = await callMemoryApi<ListValue>({ action: 'list', sessionId })
      setEntries(value.entries)
      setDir(value.dir)
      setStatus('ready')
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setStatus('failed')
    }
  }, [sessionId])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => {
    panelRef.current?.focus?.()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const select = async (entry: MemoryEntry) => {
    setBusy(true)
    setError(null)
    setReport(null)
    try {
      const value = await callMemoryApi<ReadValue>({ action: 'read', sessionId, file: entry.file })
      setView({ kind: 'edit', file: entry.file, title: entry.title, content: value.content })
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
    finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (view.kind === 'none') return
    setBusy(true)
    setError(null)
    try {
      const value = await callMemoryApi<SaveValue>({
        action: 'save',
        sessionId,
        title: view.title,
        content: view.content,
        ...(view.kind === 'edit' ? { file: view.file } : {}),
      })
      setEntries(value.entries)
      setView({ kind: 'edit', file: value.entry.file, title: value.entry.title, content: view.content })
      setStatus('ready')
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
    finally {
      setBusy(false)
    }
  }

  const remove = async (permanent: boolean) => {
    if (view.kind !== 'edit') return
    const confirmKey = permanent ? 'panel.confirmPermanent' : 'panel.confirmArchive'
    if (!window.confirm(t(confirmKey, { title: view.title }))) return
    setBusy(true)
    setError(null)
    try {
      const value = await callMemoryApi<DeleteValue>({
        action: 'delete',
        sessionId,
        file: view.file,
        permanent,
      })
      setEntries(value.entries)
      setView({ kind: 'none' })
      setStatus('ready')
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
    finally {
      setBusy(false)
    }
  }

  const openAudit = async () => {
    setBusy(true)
    setError(null)
    try {
      const value = await callMemoryApi<AuditReport>({ action: 'audit', sessionId })
      setReport({ kind: 'audit', data: value })
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
    finally {
      setBusy(false)
    }
  }

  const runSweep = async () => {
    if (!window.confirm(t('panel.confirmSweep'))) return
    setBusy(true)
    setError(null)
    try {
      const value = await callMemoryApi<SweepReport>({ action: 'sweep', sessionId, dryRun: false })
      setReport({ kind: 'sweep', data: value })
      setView({ kind: 'none' })
      await load()
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
    finally {
      setBusy(false)
    }
  }

  const editable = view.kind !== 'none'

  return h('div', {
    style: styles.scrim,
    onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
  },
    h('div', {
      ref: panelRef,
      tabIndex: -1,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('panel.title'),
      style: styles.panel,
    },
      h('div', { style: styles.header },
        h('h2', { style: styles.heading }, t('panel.title')),
        h('span', { style: styles.hint, title: dir }, dir === '' ? t('panel.hint') : `${dir}`),
        h('button', { type: 'button', style: styles.close, onClick: onClose, 'aria-label': t('panel.close') }, '✕'),
      ),
      h('div', { style: styles.main },
        h('ul', { style: styles.list },
          entries.length === 0
            ? h('li', { style: { ...styles.empty, padding: '12px 8px' } }, t('panel.empty'))
            : entries.map(entry => h(SummaryItem, {
              key: entry.file,
              entry,
              active: view.kind === 'edit' && view.file === entry.file,
              onSelect: select,
            })),
        ),
        h('div', { style: styles.editor },
          report !== null
            ? h(React.Fragment, null,
              h('h3', { style: styles.heading }, t('panel.auditTitle')),
              h('pre', { style: { ...styles.body, margin: '0', maxHeight: '380px' } }, reportLines(report, t).join('\n')),
            )
            : view.kind === 'none'
              ? h('div', { style: styles.empty },
                h('div', null, t('panel.none')),
                h('div', { style: { ...styles.label, marginTop: '6px' } }, t('panel.hint')),
              )
              : h(React.Fragment, null,
                h('label', { style: styles.label, htmlFor: 'memory-title' }, t('panel.titleLabel')),
                h('input', {
                  id: 'memory-title',
                  style: styles.input,
                  value: view.title,
                  placeholder: t('panel.titlePlaceholder'),
                  onChange: (event: React.ChangeEvent<HTMLInputElement>) => setView({ ...view, title: event.target.value }),
                }),
                h('label', { style: styles.label, htmlFor: 'memory-content' }, t('panel.contentLabel')),
                h('textarea', {
                  id: 'memory-content',
                  style: styles.textarea,
                  value: view.content,
                  placeholder: t('panel.contentPlaceholder'),
                  onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setView({ ...view, content: event.target.value }),
                }),
              ),
        ),
      ),
      h('div', { style: styles.footer },
        h('span', { style: error === null ? styles.status : styles.error },
          error ?? (status === 'loading' ? t('panel.loading') : t('panel.count', { count: entries.length }))),
        report !== null
          ? h(React.Fragment, null,
            h('button', { type: 'button', style: styles.button, onClick: () => setReport(null) }, t('panel.back')),
            report.kind === 'audit'
              ? h('button', { type: 'button', style: styles.primary, onClick: runSweep, disabled: busy }, t('panel.sweep'))
              : null,
          )
          : h(React.Fragment, null,
            h('button', { type: 'button', style: styles.button, onClick: openAudit, disabled: busy }, t('panel.tidy')),
            h('button', {
              type: 'button',
              style: styles.button,
              onClick: () => {
                setReport(null)
                setView({ kind: 'new', title: '', content: '' })
              },
            }, t('panel.new')),
            view.kind === 'edit'
              ? h('button', { type: 'button', style: styles.button, onClick: () => { void remove(false) }, disabled: busy }, t('panel.archive'))
              : null,
            view.kind === 'edit'
              ? h('button', { type: 'button', style: styles.danger, onClick: () => { void remove(true) }, disabled: busy }, t('panel.permanent'))
              : null,
            editable
              ? h('button', {
                type: 'button',
                style: styles.primary,
                onClick: save,
                disabled: busy || view.title.trim() === '' || view.content.trim() === '',
              }, t('panel.save'))
              : null,
          ),
      ),
    ),
  )
}

/** Overlay entry: renders the panel only while the shared store says open. */
function MemoryPanelOverlay({ store, t }: { store: PanelStore; t: Translate }): React.ReactElement | null {
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  if (!state.open) return null
  return h(MemoryPanel, { sessionId: state.sessionId, t, onClose: store.close })
}

export const inject = ['slots', 'locale', 'uiConversation']

/**
 * Register the Chat row, the `/memory` panel, and the command that opens it.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  const panel = createPanelStore()

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'memory: dictionaries')
  ctx.effect(() => ctx.uiConversation.events.register(memoryMessageDefinition), 'memory: chat node definition')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'memory-message',
    locale: NS,
  }, MemoryRow))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'memory.panel',
    locale: NS,
    inject: () => ({ store: panel }),
  }, MemoryPanelOverlay))

  // `/memory` is client-only: it opens the panel and submits nothing.
  ctx.inject(['commandUi'], (scope) => {
    scope.effect(() => scope.commandUi.register({
      name: 'memory',
      label: () => t('command.title'),
      description: () => t('command.description'),
      available: session => typeof session?.sessionId === 'string',
      ui: {
        kind: 'action',
        run: session => panel.open(session.sessionId),
      },
    }), 'memory: command')
  })
}
