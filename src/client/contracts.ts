/**
 * Structural contracts for the browser half.
 *
 * The Client half runs inside the page's module table, where the registered
 * adapters of the Harness Client packages merge their services into the Cordis
 * `Context`. Only the members this plugin calls are restated here: the bundle
 * stays free of Client package build dependencies while every registration is
 * still typechecked.
 *
 * @module @local/dsh-memory/client-contracts
 */

import type { ComponentType } from 'react'

/** Locale interpolation parameters. */
export type TranslateParams = Record<string, string | number>

/** Translate one key inside the plugin's locale namespace. */
export type Translate = (key: string, params?: TranslateParams) => string

/** One locale's flat message dictionary. */
export type LocaleDictionary = Record<string, string>

/** Client locale service as consumed by this plugin. */
export interface LocaleRuntime {
  /** Bind one namespace and return its translator. */
  bind(namespace: string): Translate
  /** Register dictionaries for one namespace. */
  register(namespace: string, dictionaries: Record<string, LocaleDictionary>): () => void
}

/** Options accepted by one Slot registration. */
export interface SlotRegistrationOptions {
  /** Slot key being contributed to. */
  name: string
  /** Stable entry key inside that slot. */
  key?: string
  /** Stable single-instance entry id inside that slot. */
  id?: string
  /** Locale namespace passed to the rendered component. */
  locale?: string
  /** Extra props merged into the rendered component's props. */
  inject?: () => Record<string, unknown>
}

/** Client Slot registry as consumed by this plugin. */
export interface SlotsRuntime {
  /** Contribute into a slot, waiting until its owner provides the slot. */
  inject(slotName: string, callback: () => (() => void) | void): void
  /** Register one component into a provided slot. */
  register(options: SlotRegistrationOptions, component: ComponentType<any>): () => void
}

/** One user or assistant surface event observed by a Chat node definition. */
export interface ConversationEventLike {
  /** Durable event type. */
  readonly type: string
  /** Durable event sequence. */
  readonly seq: number
  /** Event payload; producers shape it, consumers narrow it. */
  readonly data: Record<string, any>
}

/** Match returned by a Chat node definition when it claims an event. */
export interface ConversationMatchResult {
  /** Stable node identity. */
  id: string
  /** Claim the whole event as one start node. */
  role: 'start'
  /** Exclude the built-in classifiers for this event. */
  exclusive: true
}

/** Match context handed to `start`. */
export interface ConversationMatch extends ConversationMatchResult {
  /** The claimed event. */
  event: ConversationEventLike
  /** Assembler-owned start location, when resolved. */
  location?: unknown
}

/** View context handed to `buildViewNode`. */
export interface ConversationViewContext<State> {
  /** Stable key of the node being assembled. */
  key: string
  /** Stable identity of the node being assembled. */
  id: string
  /** Current durable state, absent before the start event lands. */
  state?: State
  /** Assembler-owned start facts. */
  start?: { location?: unknown }
}

/** One rendered conversation node. */
export interface ConversationViewNode {
  key: string
  kind: string
  id: string
  target: 'chat'
  anchorSeq: number
  location: unknown
  visibility: 'visible'
  groupTree: 'turn'
  data: unknown
}

/** A Chat node definition claimed exclusively for one event kind. */
export interface ConversationNodeDefinition<State> {
  kind: string
  target: 'chat'
  match(event: ConversationEventLike): ConversationMatchResult | null
  start(context: unknown, match: ConversationMatch): State
  update(context: { state?: State }): State | undefined
  buildViewNode(context: ConversationViewContext<State>): ConversationViewNode | null
}

/** Client Conversation registries as consumed by this plugin. */
export interface UiConversationRuntime {
  events: {
    register(definition: ConversationNodeDefinition<any>): () => void
  }
}

/** Client command palette registration. */
export interface CommandDefinition {
  name: string
  label: () => string
  description: () => string
  available: (session: { sessionId?: unknown } | undefined) => boolean
  ui: {
    kind: 'action'
    run: (session: { sessionId: string }) => void
  }
}

/** Client command registry as consumed by this plugin. */
export interface CommandUiRuntime {
  register(definition: CommandDefinition): () => void
}

/** The Client plugin context surface this plugin uses. */
export interface ClientContext {
  /** Register a cleanup-aware effect. */
  effect(factory: () => (() => void) | void, label?: string): unknown
  /** Wait for one Client service before running the callback. */
  inject(deps: string[], callback: (scope: ClientContext) => void): void
  locale: LocaleRuntime
  slots: SlotsRuntime
  uiConversation: UiConversationRuntime
  commandUi: CommandUiRuntime
}
