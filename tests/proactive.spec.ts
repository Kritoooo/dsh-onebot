import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Config } from '../src/index.js'
import { PROACTIVE_DEFAULTS, ProactiveReplies } from '../src/proactive.js'
import type { ProactiveConfig, ProactiveTurn } from '../src/proactive.js'
import { normalizeOneBot11 } from '../src/inbound.js'
import { makeEvent, makeHarness } from './helpers/bridge-harness.js'
import { answerRequest } from './helpers/decision-response.js'

function config(overrides: Partial<ProactiveConfig> = {}): ProactiveConfig {
  return { ...PROACTIVE_DEFAULTS, enabled: true, shadow: false, groups: ['888'], quietMs: 5,
    decisionIntervalMs: 0, cooldownMs: 0, ttlMs: 5_000, ...overrides,
    decision: { ...PROACTIVE_DEFAULTS.decision, ...overrides.decision, apiKeyEnv: 'TEST_DECISION_KEY' } }
}
function message(text: string, id: number, user = 20001, mention = false, group = 888) {
  return { message_type: 'group', post_type: 'message', user_id: user, group_id: group, message_id: id,
    sender: { nickname: '群友' + user },
    message: [...(mention ? [{ type: 'at', data: { qq: '10002' } }] : []), { type: 'text', data: { text } }],
  }
}
function emit(h: Awaited<ReturnType<typeof makeHarness>>, type: string, data: object) {
  h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent(type, { turn: 1, ...data }))
}
async function finish(h: Awaited<ReturnType<typeof makeHarness>>, text = '可以先检查 OneBot 端口。') {
  emit(h, 'turn/start', {})
  emit(h, 'assistant/message', { message: { id: 'final', role: 'assistant', content: [{ type: 'text', text }] } })
  emit(h, 'turn/end', { reason: { kind: 'completed' } })
}
const harnesses: Array<Awaited<ReturnType<typeof makeHarness>>> = []
async function harness(c?: ProactiveConfig, memberTools?: 'none' | 'all') {
  const h = await makeHarness({ proactive: c, memberTools, interimMessages: true, textImageThreshold: 150 })
  harnesses.push(h)
  return h
}
function provider(overrides: Record<string, number | string> = {}) {
  vi.stubEnv('TEST_DECISION_KEY', 'test-key')
  const request = vi.fn(async (_url: URL, init: RequestInit) => answerRequest(init, overrides))
  vi.stubGlobal('fetch', request)
  return request
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) { h.client.close(); await h.bridge.stop(); await h.connection.stop() }
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers()
})

describe('proactive group integration', () => {
  it('is off by default and starts enabled deployments in shadow mode', () => {
    expect(Config({}).proactive).toMatchObject({ enabled: false, shadow: true, groups: [] })
    expect(Config({ proactive: { enabled: true, groups: ['888'] } }).proactive.decision.provider).toBe('typesafe')
  })

  it('keeps ordinary unmentioned messages out of the model when disabled', async () => {
    const request = provider()
    const h = await harness()
    await h.bridge.handleInbound(message('有人能帮忙吗？', 1))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(request).not.toHaveBeenCalled()
    expect(h.captured.followups).toHaveLength(0)
  })

  it('keeps distinct speakers, raw text and references in one member-scoped group turn', async () => {
    const request = provider()
    const h = await harness(config(), 'all')
    await h.bridge.handleInbound(message('这个插件怎么连不上？', 1, 10001))
    await h.bridge.handleInbound({ ...message('QQ 在线但是 OneBot 连接失败', 2, 20002),
      message: [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: 'QQ 在线但是 OneBot 连接失败' } }] })
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(request).toHaveBeenCalledTimes(1)
    const text = h.captured.followups[0].text
    expect(text).toContain('目标消息：2')
    expect(text).toContain('"speaker":"10001"')
    expect(text).toContain('"speaker":"20002"')
    expect(text).toContain('"replyTo":"1"')
    expect(text).toContain('QQ 在线但是 OneBot 连接失败')
    emit(h, 'turn/start', {})
    expect(h.bridge.canEditFiles(h.sessionIds[0])).toBe(false)
    expect(h.bridge.memberToolsAllowed(h.sessionIds[0])).toBe(false)
    const gate = h.captured.agentListeners.find(listener => listener.event === 'tools/pre-execute')!
    const next = vi.fn(async () => ({ kind: 'allow' }))
    expect(await gate.listener({ agent: { session: { id: h.sessionIds[0] } } }, next)).toMatchObject({ kind: 'deny' })
    expect(next).not.toHaveBeenCalled()
  })

  it('produces no model turn or QQ receipt when the decision rejects', async () => {
    const request = provider({ addressed: 0.01, invitation: 0.01, value: 0.01 })
    const h = await harness(config())
    await h.bridge.handleInbound(message('嗯嗯', 1))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(h.captured.followups).toHaveLength(0)
    expect(h.outbound).toHaveLength(0)
  })

  it('only evaluates in shadow mode', async () => {
    const request = provider()
    const h = await harness(config({ shadow: true }))
    await h.bridge.handleInbound(message('有人能帮忙吗？', 1))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(h.captured.followups).toHaveLength(0)
    expect(h.outbound).toHaveLength(0)
  })

  it('keeps provider errors silent and does not create a reply session', async () => {
    const request = vi.fn(async () => { throw new Error('provider unavailable') })
    vi.stubEnv('TEST_DECISION_KEY', 'test-key')
    vi.stubGlobal('fetch', request)
    const h = await harness(config())
    await h.bridge.handleInbound(message('有人知道吗？', 1))
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(h.captured.followups).toHaveLength(0)
    expect(h.outbound).toHaveLength(0)
  })

  it('does not emit the normal error notice for a failed proactive turn', async () => {
    provider()
    const h = await harness(config())
    await h.bridge.handleInbound(message('有人知道吗？', 1))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    emit(h, 'turn/start', {})
    emit(h, 'turn/end', { reason: { kind: 'error', error: { message: 'failed' } } })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.outbound).toHaveLength(0)
  })

  it('routes explicit mentions directly even if the decision provider is broken', async () => {
    const request = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', request)
    const h = await harness(config())
    await h.bridge.handleInbound(message('你好', 1, 20001, true))
    expect(h.captured.followups).toHaveLength(1)
    expect(request).not.toHaveBeenCalled()
    expect(h.captured.followups[0].text).toContain('[@我]')
  })

  it('does not leave a proactive role queued after the host rejects dispatch', async () => {
    provider()
    const h = await harness(config(), 'all')
    const create = h.agents.create.getMockImplementation()!
    const rejected = vi.fn()
    h.agents.create.mockImplementationOnce(async options => {
      const handle = await create(options)
      const followup = handle.agent.followup
      handle.agent.followup = vi.fn().mockImplementationOnce(() => { rejected(); throw new Error('host rejected') }).mockImplementation(followup)
      return handle
    })
    await h.bridge.handleInbound(message('有人知道吗？', 1))
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce())
    await h.bridge.handleInbound(message('明确请求', 2, 10001, true))
    emit(h, 'turn/start', {})
    expect(h.bridge.canEditFiles(h.sessionIds[0])).toBe(true)
    expect(h.bridge.memberToolsAllowed(h.sessionIds[0])).toBe(true)
    expect(h.captured.followups).toHaveLength(1)
  })

  it('emits one final text only and never emits tool-carrying interim prose', async () => {
    provider()
    const h = await harness(config())
    await h.bridge.handleInbound(message('有人知道吗？', 1))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    emit(h, 'turn/start', {})
    emit(h, 'assistant/message', { message: { id: 'interim', role: 'assistant', content: [
      { type: 'text', text: '我正在检查，请稍等。' }, { type: 'tool-call', name: 'qq_send_image', id: 'call', arguments: '{}' },
    ] } })
    expect(h.outbound).toHaveLength(0)
    emit(h, 'assistant/message', { message: { id: 'final', role: 'assistant', content: [{ type: 'text', text: '先检查一下端口。' }] } })
    expect(h.outbound).toHaveLength(0)
    emit(h, 'turn/end', { reason: { kind: 'completed' } })
    await vi.waitFor(() => expect(h.outbound.filter(frame => frame.action === 'send_msg')).toHaveLength(1))
    expect(h.outbound[0].params.message).toEqual([{ type: 'text', data: { text: '先检查一下端口。' } }])
  })

  it.each(['[[不回]]', 'x'.repeat(601)])('silently drops an empty decision or oversized final', async text => {
    provider()
    const h = await harness(config())
    await h.bridge.handleInbound(message('有人知道吗？', 1))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await finish(h, text)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.outbound).toHaveLength(0)
  })

  it('rechecks a changed conversation and drops a now-unhelpful reply', async () => {
    const request = provider()
    const h = await harness(config())
    await h.bridge.handleInbound(message('有人知道怎么修吗？', 1))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await h.bridge.handleInbound(message('已经解决了，不用回复了', 2, 20002))
    request.mockImplementationOnce(async (_url, init) => answerRequest(init, { invitation: 0, value: 0 }))
    await finish(h)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    expect(h.outbound).toHaveLength(0)
  })

  it('does not send after the target is recalled', async () => {
    provider()
    const h = await harness(config())
    await h.bridge.handleInbound(message('有人知道吗？', 1))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.bridge.handleNotice({ notice_type: 'group_recall', group_id: 888, message_id: 1 })
    await finish(h)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.outbound).toHaveLength(0)
  })

  it.each(['/silent 30', '/stop'])('drops its draft after the administrator sends %s', async command => {
    provider()
    const h = await harness(config())
    await h.bridge.handleInbound(message('有人知道吗？', 1))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const handle = await h.agents.create.mock.results[0].value
    handle.agent.status = 'running'
    emit(h, 'turn/start', {})
    await h.bridge.handleInbound(message(command, 2, 10001, true))
    emit(h, 'assistant/message', { message: { id: 'cancelled-draft', role: 'assistant', content: [{ type: 'text', text: '不应发送的草稿' }] } })
    emit(h, 'turn/end', { reason: { kind: 'cancelled' } })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.outbound.some(frame => JSON.stringify(frame).includes('不应发送的草稿'))).toBe(false)
    expect(h.outbound.some(frame => frame.action === 'send_msg')).toBe(true) // command acknowledgement only
  })

  it('drops a pending draft when the OneBot connection disconnects', async () => {
    provider()
    const h = await harness(config())
    await h.bridge.handleInbound(message('有人知道吗？', 1))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    emit(h, 'turn/start', {})
    h.client.close()
    await vi.waitFor(() => expect(h.connection.connected).toBe(false))
    emit(h, 'assistant/message', { message: { id: 'disconnected', role: 'assistant', content: [{ type: 'text', text: '断线后不补发' }] } })
    emit(h, 'turn/end', { reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.outbound).toHaveLength(0)
  })

  it('lets an explicit request supersede an unfinished proactive answer', async () => {
    provider()
    const h = await harness(config())
    await h.bridge.handleInbound(message('有人知道吗？', 1))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    emit(h, 'turn/start', {})
    await h.bridge.handleInbound(message('请回答这个问题', 2, 20002, true))
    emit(h, 'assistant/message', { message: { id: 'old', role: 'assistant', content: [{ type: 'text', text: '过时的插话' }] } })
    emit(h, 'turn/end', { reason: { kind: 'completed' } })
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.outbound.some(frame => JSON.stringify(frame).includes('过时的插话'))).toBe(false)
  })

  it('does not include previously submitted group messages a second time', async () => {
    provider()
    const h = await harness(config())
    await h.bridge.handleInbound(message('第一条独有原文', 1))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await finish(h)
    await vi.waitFor(() => expect(h.outbound.some(frame => frame.action === 'send_msg')).toBe(true))
    await h.bridge.handleInbound(message('那第二个问题呢？', 2))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].text).not.toContain('第一条独有原文')
    expect(h.captured.followups[1].sessionId).toBe(h.captured.followups[0].sessionId)
  })

  it('does not observe other groups or trigger on its own echoed message', async () => {
    const request = provider()
    const h = await harness(config())
    await h.bridge.handleInbound(message('别群消息', 1, 20001, false, 999))
    await h.bridge.handleInbound(message('机器人自己的消息', 2, 10002))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(request).not.toHaveBeenCalled()
    expect(h.captured.followups).toHaveLength(0)
  })
})

describe('persistent proactive budget', () => {
  it('does not reset an exhausted budget when the scheduler restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'onebot-budget-'))
    await writeFile(join(dir, 'proactive-quotas.json'), JSON.stringify({ 'group:888': [Date.now()] }))
    const request = provider()
    const dispatch = vi.fn(async (_turn: ProactiveTurn, _text: string) => true)
    const scheduler = new ProactiveReplies({ config: config({ hourlyLimit: 1 }), mediaDir: dir,
      allowed: () => true, busy: () => false, dispatch, cancelRunning: () => undefined,
      send: async () => 'sent', log: () => undefined })
    scheduler.observe(normalizeOneBot11(message('有人知道吗？', 1))!, false)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(request).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    await scheduler.stop()
  })
})

describe('proactive lifecycle and conversational window', () => {
  async function scheduler(c: Partial<ProactiveConfig> = {}) {
    const turns: ProactiveTurn[] = []
    const sent: string[] = []
    const cancelled = vi.fn()
    const manager = new ProactiveReplies({ config: config(c), mediaDir: await mkdtemp(join(tmpdir(), 'onebot-proactive-')),
      allowed: () => true, busy: () => false,
      dispatch: async turn => { turns.push(turn); return true }, cancelRunning: cancelled,
      send: async (_chat, text, guard) => { if (!guard()) return undefined; sent.push(text); return 'sent-' + sent.length }, log: () => undefined })
    return { manager, turns, sent, cancelled }
  }
  async function complete(s: Awaited<ReturnType<typeof scheduler>>, id: number) {
    s.manager.observe(normalizeOneBot11(message('第 ' + id + ' 个问题', id))!, false)
    await vi.waitFor(() => expect(s.turns).toHaveLength(id))
    s.manager.startTurn('group:888')
    s.manager.capture('group:888', '这是第 ' + id + ' 条回复', false)
    await s.manager.finish('group:888', true)
  }

  it('allows at most two relevant follow-ups to bypass a two-minute cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const request = provider()
    const s = await scheduler({ cooldownMs: 120_000 })
    try {
      for (let id = 1; id <= 3; id++) {
        await complete(s, id)
        vi.setSystemTime(Date.now() + 1_000)
      }
      s.manager.observe(normalizeOneBot11(message('继续说', 4))!, false)
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(s.sent).toHaveLength(3)
      expect(s.turns).toHaveLength(3)
      expect(request).toHaveBeenCalledTimes(3)
    } finally { await s.manager.stop() }
  })

  it('drops expired content and reports that its draft was not delivered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    provider()
    const s = await scheduler()
    try {
      s.manager.observe(normalizeOneBot11(message('有人知道吗？', 1))!, false)
      await vi.waitFor(() => expect(s.turns).toHaveLength(1))
      s.manager.startTurn('group:888')
      s.manager.capture('group:888', '过时的回复', false)
      vi.setSystemTime(Date.now() + 10_000)
      await s.manager.finish('group:888', true)
      expect(s.sent).toHaveLength(0)
      expect(s.manager.deliveryContext('group:888')).toContain('"status":"unsent"')
      expect(s.manager.deliveryContext('group:888')).toContain('不要认为群友已经看过')
    } finally { await s.manager.stop() }
  })

  it('starts a fresh observation cycle after the prior group session is reset', async () => {
    provider()
    const s = await scheduler()
    try {
      s.manager.observe(normalizeOneBot11(message('旧话题', 1))!, false)
      await vi.waitFor(() => expect(s.turns).toHaveLength(1))
      s.manager.reset('group:888')
      s.manager.observe(normalizeOneBot11(message('新话题', 2))!, false)
      await vi.waitFor(() => expect(s.turns).toHaveLength(2))
      expect(s.turns[1].messages.map(item => item.text)).toEqual(['新话题'])
      expect(s.manager.valid(s.turns[0])).toBe(false)
    } finally { await s.manager.stop() }
  })

  it('keeps the raw quote chain even when relevance scores exclude its ancestors', async () => {
    provider({ context_0: 0, context_1: 0 })
    const s = await scheduler()
    try {
      s.manager.observe(normalizeOneBot11(message('引用链最初的内容', 1))!, false)
      for (const id of [2, 3]) {
        const event = { ...message('引用链第 ' + id + ' 层', id), message: [
          { type: 'reply', data: { id: String(id - 1) } }, { type: 'text', data: { text: '引用链第 ' + id + ' 层' } },
        ] }
        s.manager.observe(normalizeOneBot11(event)!, false)
      }
      await vi.waitFor(() => expect(s.turns).toHaveLength(1))
      expect(s.turns[0].messages.map(item => item.id)).toEqual(['1', '2', '3'])
    } finally { await s.manager.stop() }
  })

  it('cancels an in-flight draft when an explicit request arrives', async () => {
    provider()
    const s = await scheduler()
    try {
      s.manager.observe(normalizeOneBot11(message('有人知道吗？', 1))!, false)
      await vi.waitFor(() => expect(s.turns).toHaveLength(1))
      s.manager.startTurn('group:888')
      s.manager.capture('group:888', '旧草稿', false)
      s.manager.observe(normalizeOneBot11(message('先回答这个', 2, 20002, true))!, true)
      await s.manager.finish('group:888', true)
      expect(s.cancelled).toHaveBeenCalledOnce()
      expect(s.sent).toHaveLength(0)
    } finally { await s.manager.stop() }
  })
})
