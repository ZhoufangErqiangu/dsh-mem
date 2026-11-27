/**
 * Client half of `@local/dsh-memory`: renders the injected project-memory block
 * as its own Chat row instead of a collapsed context injection.
 *
 * The Definition claims `user/message` events whose source kind is `memory` with
 * `exclusive: true`, so the built-in input-message Definition does not also
 * classify them. The row sits at group-tree position `turn`, which keeps it
 * outside the Turn's process disclosure and therefore visible.
 *
 * @module @local/dsh-memory/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'memory'

    const zh = {
      'row.title': '项目记忆',
      'row.count': '{count} 条',
      'row.empty': '尚无条目',
      'row.show': '展开记忆索引',
      'row.hide': '收起记忆索引',
    }
    const en = {
      'row.title': 'Project memory',
      'row.count': '{count} saved',
      'row.empty': 'no notes yet',
      'row.show': 'Show the memory index',
      'row.hide': 'Hide the memory index',
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
    }

    function textOf(content) {
      if (!Array.isArray(content)) return ''
      return content
        .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
    }

    /** One visible, expandable row for one injected memory index. */
    function MemoryRow({ node, t }) {
      const data = node.data ?? {}
      const [open, setOpen] = React.useState(false)
      const text = typeof data.text === 'string' ? data.text : ''
      const count = Number.isInteger(data.count) ? data.count : 0
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
    const memoryMessageDefinition = {
      kind: 'memory-message',
      target: 'chat',
      match(event) {
        if (event.type !== 'user/message') return null
        const source = event.data?.source
        if (source === null || typeof source !== 'object' || source.kind !== NS) return null
        return { id: String(event.data.id), role: 'start', exclusive: true }
      },
      start(_context, match) {
        const event = match.event
        const source = event.data.source
        return {
          seq: event.seq,
          text: textOf(event.data.content),
          count: Number.isInteger(source.entryCount) ? source.entryCount : 0,
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

    return {
      inject: ['slots', 'locale', 'uiConversation'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'memory: dictionaries')
        ctx.effect(() => ctx.uiConversation.events.register(memoryMessageDefinition), 'memory: chat node definition')
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node',
          key: 'memory-message',
          locale: NS,
        }, MemoryRow))
      },
    }
  },
})
