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
import type { MemoryEntry } from '../types.ts'
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
  'panel.delete': '删除',
  'panel.confirmDelete': '确定删除「{title}」？此操作不可撤销。',
  'panel.close': '关闭',
  'panel.loading': '加载中…',
  'panel.none': '从左侧选择一条记忆',
  'panel.titleLabel': '标题',
  'panel.contentLabel': '内容',
  'panel.saved': '已保存',
  'panel.deleted': '已删除',
  'panel.titlePlaceholder': '给这条记忆起个名字',
  'panel.contentPlaceholder': '写清楚学到了什么、为什么重要、下次怎么做。',
  'panel.count': '{count} 条记忆',
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
  'panel.delete': 'Delete',
  'panel.confirmDelete': 'Delete "{title}"? This cannot be undone.',
  'panel.close': 'Close',
  'panel.loading': 'Loading…',
  'panel.none': 'Pick a memory on the left',
  'panel.titleLabel': 'Title',
  'panel.contentLabel': 'Content',
  'panel.saved': 'Saved',
  'panel.deleted': 'Deleted',
  'panel.titlePlaceholder': 'Name this memory',
  'panel.contentPlaceholder': 'What was learned, why it matters, and what to do next time.',
  'panel.count': '{count} items',
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
}

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

/** The management panel: list, read, edit, create, delete. */
function MemoryPanel({ sessionId, t, onClose }: MemoryPanelProps): React.ReactElement {
  const [entries, setEntries] = React.useState<MemoryEntry[]>([])
  const [dir, setDir] = React.useState('')
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [view, setView] = React.useState<PanelView>({ kind: 'none' })
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

  const remove = async () => {
    if (view.kind !== 'edit') return
    if (!window.confirm(t('panel.confirmDelete', { title: view.title }))) return
    setBusy(true)
    setError(null)
    try {
      const value = await callMemoryApi<DeleteValue>({ action: 'delete', sessionId, file: view.file })
      setEntries(value.entries)
      setView({ kind: 'none' })
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
          view.kind === 'none'
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
        h('button', {
          type: 'button',
          style: styles.button,
          onClick: () => setView({ kind: 'new', title: '', content: '' }),
        }, t('panel.new')),
        view.kind === 'edit'
          ? h('button', { type: 'button', style: styles.button, onClick: remove, disabled: busy }, t('panel.delete'))
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
