import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatId } from './chat.js'
import { sanitizeNickname, wrapUserMessage } from './chat.js'
import type { NormalizedInbound } from './inbound.js'
import { evaluateReply } from './decision.js'
import type { DecisionConfig, DecisionInput, ObservedMessage, ReplyDecision } from './decision.js'
import type { BotIdentity } from './identity.js'

export interface ProactiveConfig {
  enabled: boolean
  shadow: boolean
  groups: string[]
  ignoredUsers: string[]
  botProfile: string
  quietMs: number
  waitMaxMs: number
  decisionIntervalMs: number
  cooldownMs: number
  hourlyLimit: number
  dailyLimit: number
  ttlMs: number
  addressedThreshold: number
  invitationThreshold: number
  valueThreshold: number
  silenceBoost: number
  interruptionThreshold: number
  decision: DecisionConfig
}

export const PROACTIVE_DEFAULTS: ProactiveConfig = {
  enabled: false, shadow: true, groups: [], ignoredUsers: [],
  botProfile: 'QQ 群里的 AI 群友：自然中文，会接梗，也能认真帮忙。',
  quietMs: 3_000, waitMaxMs: 8_000, decisionIntervalMs: 8_000,
  cooldownMs: 120_000, hourlyLimit: 6, dailyLimit: 30, ttlMs: 30_000,
  addressedThreshold: 0.85, invitationThreshold: 0.8, valueThreshold: 0.85, interruptionThreshold: 0.2,
  silenceBoost: 0.10,
  decision: { provider: 'typesafe', endpoint: '', model: '', apiKeyEnv: '', timeoutMs: 1_500 },
}

export interface ProactiveTurn {
  id: string
  chatId: ChatId
  target: ObservedMessage
  messages: ObservedMessage[]
  decision: ReplyDecision
  valueThreshold: number
  revision: number
  createdAt: number
  cancelled: boolean
  started: boolean
  text: string
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
}

interface GroupState {
  messages: ObservedMessage[]
  provided: Set<string>
  revision: number
  lastDecisionAt: number
  pendingSince: number
  lastTarget?: string
  timer?: ReturnType<typeof setTimeout>
  deciding?: AbortController
  turn?: ProactiveTurn
  continuationUntil: number
  continuationCount: number
  lastSentAt: number
  silenceSince: number
  activityIds: Set<string>
}

export interface ProactiveContext {
  identity?: Pick<BotIdentity, 'resolve' | 'current'>
  config: ProactiveConfig
  mediaDir: string
  allowed(chatId: ChatId): boolean
  busy(chatId: ChatId): boolean
  dispatch(turn: ProactiveTurn, text: string): Promise<boolean>
  cancelRunning(chatId: ChatId): void
  /** Must check guard immediately before the wire send, after any send queue. */
  send(chatId: ChatId, text: string, guard: () => boolean): Promise<string | undefined>
  log(level: 'info' | 'warn' | 'debug', message: string): void
}

/** Buffer and scheduler are group-local; decision providers never own conversation memory. */
export class ProactiveReplies {
  private readonly groups = new Map<ChatId, GroupState>()
  private readonly quotas = new Map<ChatId, number[]>()
  private readonly deliveries = new Map<ChatId, Array<{ id: string; target: string; status: 'pending' | 'sent' | 'unsent' }>>()
  private readonly ready: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  private stopped = false
  private localId = 0
  private readonly localIds = new WeakMap<NormalizedInbound, string>()

  constructor(private readonly ctx: ProactiveContext) {
    if (ctx.config.groups.length > 128) this.stopped = true
    this.ready = ctx.config.enabled ? this.loadQuotas() : Promise.resolve()
  }

  private state(chatId: ChatId): GroupState {
    let state = this.groups.get(chatId)
    if (!state) {
      state = { messages: [], provided: new Set(), revision: 0, lastDecisionAt: 0, pendingSince: 0,
        continuationUntil: 0, continuationCount: 0, lastSentAt: 0, silenceSince: Date.now(), activityIds: new Set() }
      this.groups.set(chatId, state)
    }
    return state
  }

  private enabled(chatId: ChatId): boolean {
    return !this.stopped && this.ctx.config.enabled && chatId.startsWith('group:')
      && this.ctx.config.groups.includes(chatId.slice(6)) && this.ctx.allowed(chatId)
  }

  /** Called only after the existing access/duplicate/self and quote-author checks. */
  observe(inbound: NormalizedInbound, direct: boolean): void {
    if (!this.enabled(inbound.chatId) || inbound.kind !== 'group') return
    const state = this.state(inbound.chatId)
    if (direct) this.cancel(inbound.chatId, !/^\s*\//.test(inbound.text))
    if (this.ctx.config.ignoredUsers.includes(inbound.userId) || /^\s*\//.test(inbound.text)) return
    const now = Date.now()
    const at = inbound.time > 0 ? inbound.time * 1000 : now
    if (now - at > 600_000 || at - now > 60_000) return
    const text = inbound.text.trim().slice(0, 800)
    if (!text) return
    const id = inbound.messageId ?? 'local-' + ++this.localId
    if (inbound.messageId === undefined) this.localIds.set(inbound, id)
    const mediaOnly = inbound.media.length > 0 && !text.replace(/\[(?:图片|语音|视频|文件|表情包)[^\]]*\]/g, '').trim()
    const added = this.append(state, {
      id, speaker: inbound.userId, nickname: sanitizeNickname(inbound.nickname), text,
      replyTo: inbound.replyId, at, bot: false, candidate: !mediaOnly && !direct,
    })
    if (added && !direct && !mediaOnly) state.activityIds.add(id)
    const buffered = new Set(state.messages.map(message => message.id))
    for (const observedId of state.activityIds) if (!buffered.has(observedId)) state.activityIds.delete(observedId)
    // Direct messages already use the original pipeline; never trigger a second turn.
    if (direct) return
    // Media-only events are context, not an excuse to guess their content.
    if (mediaOnly) return
    if (state.turn) return
    this.schedule(inbound.chatId, state)
  }

  private append(state: GroupState, message: ObservedMessage): boolean {
    if (state.messages.some(item => item.id === message.id)) return false
    state.messages = [...state.messages.filter(item => Date.now() - item.at < 600_000), message].slice(-40)
    state.revision++
    // This set is session-local, bounded independently of the 40-message buffer.
    while (state.provided.size > 1_000) state.provided.delete(state.provided.values().next().value!)
    return true
  }

  recordBot(chatId: ChatId, id: string, text: string): void {
    if (!this.enabled(chatId)) return
    const state = this.state(chatId)
    if (!this.append(state, { id, speaker: 'bot', nickname: this.ctx.identity?.current(chatId).name ?? '', text: text.slice(0, 800), at: Date.now(), bot: true })) return
    state.silenceSince = Date.now()
    state.activityIds.clear()
    state.provided.add(id)
  }

  markProvided(inbound: NormalizedInbound): void {
    const id = inbound.messageId ?? this.localIds.get(inbound)
    if (id !== undefined && this.enabled(inbound.chatId)) this.state(inbound.chatId).provided.add(id)
  }

  recall(chatId: ChatId, id: string): void {
    const state = this.groups.get(chatId)
    if (!state) return
    state.messages = state.messages.filter(message => message.id !== id)
    state.revision++
    if (state.turn?.target.id === id) this.cancel(chatId)
  }

  /** Direct traffic, /silent, /stop, /new and disconnect invalidate speculative work. */
  cancel(chatId: ChatId, cancelRunning = true): void {
    const state = this.groups.get(chatId)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    state.pendingSince = 0
    state.revision++
    state.deciding?.abort()
    if (state.turn) {
      clearTimeout(state.turn.timer)
      state.turn.cancelled = true
      state.turn.controller.abort()
      if (state.turn.started && cancelRunning) this.ctx.cancelRunning(chatId)
    }
    state.continuationUntil = 0
    state.continuationCount = 0
  }

  reset(chatId: ChatId): void {
    this.cancel(chatId)
    const state = this.groups.get(chatId)
    if (state) {
      if (state.turn) this.deliveryStatus(state.turn, 'unsent')
      state.turn = undefined
      state.messages = []
      state.provided.clear()
      state.lastTarget = undefined
      state.silenceSince = Date.now()
      state.activityIds.clear()
    }
  }

  cancelAll(): void { for (const id of this.groups.keys()) this.cancel(id) }
  async stop(): Promise<void> { this.stopped = true; this.cancelAll(); await this.writes.catch(() => undefined) }

  private schedule(chatId: ChatId, state: GroupState): void {
    if (state.timer) clearTimeout(state.timer)
    if (state.pendingSince === 0) state.pendingSince = Date.now()
    const now = Date.now()
    const due = Math.max(Math.min(now + this.ctx.config.quietMs, state.pendingSince + this.ctx.config.waitMaxMs),
      state.lastDecisionAt + this.ctx.config.decisionIntervalMs)
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.pendingSince = 0
      void this.consider(chatId, state)
    }, Math.max(0, due - now))
    state.timer.unref?.()
  }

  private quotaAllowed(chatId: ChatId): boolean {
    const now = Date.now()
    const times = (this.quotas.get(chatId) ?? []).filter(time => now - time < 86_400_000)
    this.quotas.set(chatId, times)
    return times.length < this.ctx.config.dailyLimit
      && times.filter(time => now - time < 3_600_000).length < this.ctx.config.hourlyLimit
  }

  private continuation(state: GroupState): boolean {
    return Date.now() < state.continuationUntil && state.continuationCount < 2
  }

  private willingness(state: GroupState): { factor: number; valueThreshold: number } {
    const now = Date.now()
    const recent = state.messages.filter(message => state.activityIds.has(message.id) && now - message.at < 600_000).length
    const factor = recent >= 6 ? Math.max(0, Math.min(1, (now - state.silenceSince - 300_000) / 1_200_000)) : 0
    const base = this.ctx.config.valueThreshold
    const boost = Math.min(Math.max(0, this.ctx.config.silenceBoost), Math.max(0, base - 0.70))
    return { factor, valueThreshold: base - boost * factor }
  }

  private approved(decision: ReplyDecision, continuation: boolean, valueThreshold: number): boolean {
    const c = this.ctx.config
    if (decision.mode === 'none' || decision.interruption > c.interruptionThreshold) return false
    if (decision.addressed >= c.addressedThreshold) return true
    return !continuation && decision.invitation >= c.invitationThreshold && decision.value >= valueThreshold
  }

  private input(state: GroupState, target: ObservedMessage, continuation: boolean): DecisionInput {
    const recent = state.messages.filter(message => Date.now() - message.at < 600_000).slice(-12)
    const selected = new Set(recent.map(message => message.id))
    selected.add(target.id)
    let parent = target.replyTo
    for (let depth = 0; parent && depth < 3; depth++) {
      const message = state.messages.find(item => item.id === parent)
      if (!message) break
      selected.add(message.id)
      parent = message.replyTo
    }
    return { targetId: target.id, continuation, botProfile: this.ctx.config.botProfile,
      messages: state.messages.filter(message => selected.has(message.id)) }
  }

  private async consider(chatId: ChatId, state: GroupState): Promise<void> {
    await this.ready
    if (!this.enabled(chatId) || state.turn || state.deciding || this.ctx.busy(chatId) || !this.quotaAllowed(chatId)) return
    const continuation = this.continuation(state)
    if (!continuation && Date.now() - state.lastSentAt < this.ctx.config.cooldownMs) return
    const target = state.messages.findLast(message => !message.bot && message.candidate !== false && !state.provided.has(message.id))
    if (!target || state.lastTarget === target.id || Date.now() - target.at > this.ctx.config.ttlMs) return
    state.lastDecisionAt = Date.now()
    state.lastTarget = target.id
    const revision = state.revision
    const input = this.input(state, target, continuation)
    const willingness = this.willingness(state)
    const controller = new AbortController()
    state.deciding = controller
    try {
      input.botIdentity = await this.ctx.identity?.resolve(chatId)
      if (controller.signal.aborted || state.revision !== revision || !this.enabled(chatId)) return
      const decision = await evaluateReply(this.ctx.config.decision, input, controller.signal)
      this.ctx.log('info', '主动回复决策 ' + JSON.stringify({ chatId, provider: this.ctx.config.decision.provider,
        model: decision.model, addressed: decision.addressed, invitation: decision.invitation, value: decision.value,
        interruption: decision.interruption, mode: decision.mode, shadow: this.ctx.config.shadow,
        silenceFactor: willingness.factor, valueThreshold: willingness.valueThreshold,
        inputTokens: decision.inputTokens, outputTokens: decision.outputTokens }))
      if (controller.signal.aborted || state.revision !== revision || !this.enabled(chatId)
        || this.ctx.busy(chatId) || !this.approved(decision, false, willingness.valueThreshold)) return
      // Inside the short follow-up window, only an actual reply to the bot bypasses cooldown.
      const followsBot = continuation && this.approved(decision, true, willingness.valueThreshold)
      if (!followsBot && Date.now() - state.lastSentAt < this.ctx.config.cooldownMs) return
      if (this.ctx.config.shadow) return
      const relevant = new Set([...decision.relevantIds, target.id, ...(target.replyTo ? [target.replyTo] : [])])
      let parent = target.replyTo
      for (let depth = 0; parent && depth < 3; depth++) {
        const quoted = input.messages.find(message => message.id === parent)
        if (!quoted) break
        relevant.add(quoted.id)
        parent = quoted.replyTo
      }
      const messages = input.messages.filter(message => relevant.has(message.id) && !state.provided.has(message.id))
      const turn: ProactiveTurn = { id: randomUUID(), chatId, target, messages, decision, valueThreshold: willingness.valueThreshold, revision, createdAt: Date.now(),
        cancelled: false, started: false, text: '', controller: new AbortController() }
      state.turn = turn
      this.deliveries.set(chatId, [...(this.deliveries.get(chatId) ?? []), { id: turn.id, target: target.id, status: 'pending' }].slice(-10) as Array<{ id: string; target: string; status: 'pending' | 'sent' | 'unsent' }>)
      turn.timer = setTimeout(() => this.cancel(chatId), this.ctx.config.ttlMs)
      turn.timer.unref?.()
      const packet = this.packet(turn)
      const dispatched = await this.ctx.dispatch(turn, packet)
      if (dispatched) messages.forEach(message => state.provided.add(message.id))
      else { clearTimeout(turn.timer); this.deliveryStatus(turn, 'unsent'); if (state.turn === turn) state.turn = undefined }
    } catch {
      if (state.turn && !state.turn.started) {
        clearTimeout(state.turn.timer)
        this.deliveryStatus(state.turn, 'unsent')
        state.turn = undefined
      }
      this.ctx.log('debug', '主动回复决策未完成，保持沉默：' + chatId)
    } finally {
      if (state.deciding === controller) state.deciding = undefined
      if (!state.turn && state.revision !== revision && this.enabled(chatId)) this.schedule(chatId, state)
    }
  }

  private packet(turn: ProactiveTurn): string {
    const records = turn.messages.map(message => ({ id: message.id, speaker: message.speaker, nickname: message.nickname,
      time: new Date(message.at).toISOString(), replyTo: message.replyTo, text: message.text }))
    return '[群聊主动接话·成员权限]\n主动回合标识：' + turn.id + '\n目标消息：' + turn.target.id + '；目标发言人：' + sanitizeNickname(turn.target.nickname)
      + '\n本轮表达：' + turn.decision.mode + '。结合本群已有历史与下面的新增相关原文，只针对目标自然接话，通常一到三句。'
      + '不要总结整段群聊，不必反问。仅生成最终文字，不调用工具；没有合适内容时只输出 [[不回]]。'
      + '\n记录中每条都有独立发言人；引用的旧消息若未重复列出，请结合已有会话历史。\n'
      + wrapUserMessage(JSON.stringify(records), 'group-observer', '群聊旁听')
  }

  private deliveryStatus(turn: ProactiveTurn, status: 'sent' | 'unsent'): void {
    const entry = this.deliveries.get(turn.chatId)?.find(item => item.id === turn.id)
    if (entry) entry.status = status
  }

  /** Model-visible runtime facts: generated drafts are distinct from delivered messages. */
  deliveryContext(chatId: ChatId): string {
    return '群聊通道发送状态：历史中标记为“群聊主动接话”的 assistant 内容是待发送草稿。'
      + '只有下面 status=sent 的主动回合确认已发送到 QQ；pending、unsent 或无确认的回合，不要认为群友已经看过，也不要声称自己已经说过。'
      + '\n最近主动回合回执：' + JSON.stringify(this.deliveries.get(chatId) ?? [])
  }

  /** Used both before dispatch and at the final queued wire-send boundary. */
  valid(turn: ProactiveTurn): boolean {
    const state = this.groups.get(turn.chatId)
    return state?.turn === turn && !turn.cancelled && this.enabled(turn.chatId)
      && Date.now() - turn.createdAt <= this.ctx.config.ttlMs
      && state.messages.some(message => message.id === turn.target.id)
  }

  startTurn(chatId: ChatId): void {
    const turn = this.groups.get(chatId)?.turn
    if (!turn) return
    turn.started = true
    if (!this.valid(turn)) queueMicrotask(() => this.ctx.cancelRunning(chatId))
  }

  capture(chatId: ChatId, text: string, hasToolCall: boolean): void {
    const turn = this.groups.get(chatId)?.turn
    if (turn) turn.text = hasToolCall ? '' : text
  }

  /** Nothing is emitted until the turn completes and the live conversation is rechecked. */
  async finish(chatId: ChatId, completed: boolean): Promise<void> {
    const state = this.groups.get(chatId)
    const turn = state?.turn
    if (!state || !turn) return
    let sent = false
    try {
      const text = turn.text.trim()
      if (!completed || !text || text === '[[不回]]' || [...text].length > 600 || !this.valid(turn)) return
      let revision = state.revision
      if (revision !== turn.revision) {
        const input = this.input(state, turn.target, false)
        input.botIdentity = await this.ctx.identity?.resolve(chatId)
        const decision = await evaluateReply(this.ctx.config.decision, input, turn.controller.signal)
        if (!this.approved(decision, false, turn.valueThreshold) || decision.value < turn.valueThreshold
          || state.revision !== revision || !this.valid(turn)) return
      }
      if (!this.quotaAllowed(chatId)) return
      // Reserve conservatively: uncertain sends consume a slot and are never retried.
      const now = Date.now()
      this.quotas.set(chatId, [...(this.quotas.get(chatId) ?? []), now])
      await this.saveQuotas()
      const id = await this.ctx.send(chatId, text, () => this.valid(turn) && state.revision === revision)
      if (id !== undefined) {
        sent = true
        const continuing = this.continuation(state)
        state.lastSentAt = Date.now()
        if (continuing) state.continuationCount++
        else { state.continuationUntil = Date.now() + 90_000; state.continuationCount = 0 }
        this.recordBot(chatId, id, text)
      }
    } catch {
      this.ctx.log('debug', '主动回复已放弃，不补发：' + chatId)
    } finally {
      this.deliveryStatus(turn, sent ? 'sent' : 'unsent')
      void this.saveQuotas().catch(() => this.ctx.log('warn', '主动回复发送回执未保存'))
      clearTimeout(turn.timer)
      if (state.turn === turn) state.turn = undefined
    }
  }

  private async loadQuotas(): Promise<void> {
    try {
      const entries = JSON.parse(await readFile(join(this.ctx.mediaDir, 'proactive-quotas.json'), 'utf8')) as unknown
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('invalid')
      for (const group of this.ctx.config.groups) {
        const id: ChatId = 'group:' + group
        const times = (entries as Record<string, unknown>)[id]
        if (Array.isArray(times)) this.quotas.set(id, times.filter((time): time is number => typeof time === 'number'
          && Number.isFinite(time) && time <= Date.now() && Date.now() - time < 86_400_000).slice(-1_000))
        const receipts = (entries as Record<string, unknown>).__deliveries as Record<string, unknown> | undefined
        if (receipts && typeof receipts === 'object' && Array.isArray(receipts[id])) {
          const valid = (receipts[id] as unknown[]).filter((item): item is { id: string; target: string; status: 'sent' | 'unsent' } => {
            if (!item || typeof item !== 'object') return false
            const value = item as Record<string, unknown>
            return typeof value.id === 'string' && value.id.length <= 100 && typeof value.target === 'string'
              && value.target.length <= 100 && (value.status === 'sent' || value.status === 'unsent')
          }).slice(-10)
          this.deliveries.set(id, valid)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A corrupt quota file must not silently reset the sending budget.
        this.stopped = true
        this.ctx.log('warn', '主动回复额度文件不可读，已关闭主动回复；显式聊天仍可用')
      }
    }
  }

  private saveQuotas(): Promise<void> {
    const snapshot = JSON.stringify({ ...Object.fromEntries(this.quotas), __deliveries: Object.fromEntries(this.deliveries) })
    const task = this.writes.catch(() => undefined).then(async () => {
      await mkdir(this.ctx.mediaDir, { recursive: true })
      const path = join(this.ctx.mediaDir, 'proactive-quotas.json')
      await writeFile(path + '.tmp', snapshot, { mode: 0o600 })
      await rename(path + '.tmp', path)
    })
    this.writes = task
    return task
  }
}
