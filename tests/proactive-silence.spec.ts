import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProactiveReplies, PROACTIVE_DEFAULTS } from '../src/proactive.js'
import type { ProactiveConfig, ProactiveTurn } from '../src/proactive.js'
import { normalizeOneBot11 } from '../src/inbound.js'
import { answerRequest } from './helpers/decision-response.js'

const managers: ProactiveReplies[] = []
async function setup(config: Partial<ProactiveConfig> = {}, answers: Record<string, number | string> = {}) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.stubEnv('TEST_DECISION_KEY', 'test-key')
  const request = vi.fn(async (_url: URL, init: RequestInit) => answerRequest(init, { addressed: 0.01, value: 0.78, ...answers }))
  request.mockImplementationOnce(async (_url, init) => answerRequest(init, { addressed: 0, invitation: 0, value: 0 }))
  vi.stubGlobal('fetch', request)
  const turns: ProactiveTurn[] = [], sent: string[] = []
  const manager = new ProactiveReplies({
    config: { ...PROACTIVE_DEFAULTS, enabled: true, shadow: false, groups: ['888', '999'], quietMs: 5,
      cooldownMs: 0, decisionIntervalMs: 0, ...config,
      decision: { ...PROACTIVE_DEFAULTS.decision, apiKeyEnv: 'TEST_DECISION_KEY' } },
    mediaDir: await mkdtemp(join(tmpdir(), 'onebot-silence-')), allowed: () => true, busy: () => false,
    dispatch: async turn => { turns.push(turn); return true }, cancelRunning: () => undefined,
    send: async (_chat, text, guard) => { if (!guard()) return undefined; sent.push(text); return 'sent-' + sent.length }, log: () => undefined,
  })
  managers.push(manager)
  let id = 0
  function activity(count = 6, group = 888, duplicate = false, media = false) {
    const duplicateId = ++id
    for (let i = 0; i < count; i++) {
      const event = normalizeOneBot11({ post_type: 'message', message_type: 'group', group_id: group,
        message_id: duplicate ? duplicateId : ++id, user_id: 20001 + i % 2, sender: { nickname: '群友' },
        message: [{ type: 'text', data: { text: media ? '[图片]' : '讨论中的一个想法' } }] })!
      if (media) event.media = [{ kind: 'image', file: 'unused' } as never]
      manager.observe(event, false)
    }
  }
  activity(1)
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
  return { manager, turns, sent, request, activity, advance: (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000) }
}
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop()
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers()
})

it.each([[5, 0.82, false], [15, 0.82, true], [25, 0.76, true], [120, 0.74, false]] as const)(
  'uses a bounded silence boost after %i minutes for value %f', async (minutes, value, accepted) => {
    const s = await setup({}, { value })
    s.advance(minutes); s.activity()
    await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(2))
    expect(s.turns).toHaveLength(accepted ? 1 : 0)
  })

it('does not boost the first message after a quiet night or use stale activity', async () => {
  const s = await setup()
  s.activity()
  await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(2))
  s.advance(8 * 60); s.activity(1)
  await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(3))
  expect(s.turns).toHaveLength(0)
})

it('excludes duplicate and media-only events from the six fresh messages', async () => {
  const s = await setup()
  s.advance(25); s.activity(8, 888, true); s.activity(8, 888, false, true); s.activity(1)
  await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(2))
  expect(s.turns).toHaveLength(0)
})

it.each([
  [{ silenceBoost: 0 }, {}, false],
  [{ silenceBoost: 0.2 }, { value: 0.69 }, false],
  [{ valueThreshold: 0.65 }, { value: 0.66 }, true],
  [{}, { interruption: 0.21 }, false], [{}, { invitation: 0.79 }, false], [{}, { mode: 'none' }, false],
  [{ shadow: true }, {}, false],
] as Array<[Partial<ProactiveConfig>, Record<string, number | string>, boolean]>)(
  'preserves configuration and semantic gates: %j / %j', async (config, answers, accepted) => {
    const s = await setup(config, answers)
    s.advance(25); s.activity()
    await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(2))
    expect(s.turns).toHaveLength(accepted ? 1 : 0)
  })

it('clears willingness for any actual bot reply and keeps groups independent', async () => {
  const s = await setup()
  s.activity(1, 999)
  await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(2))
  s.advance(25)
  s.manager.recordBot('group:888', 'explicit-reply', '刚刚回复了群友')
  s.activity(); s.activity(6, 999)
  await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(4))
  expect(s.turns.map(turn => turn.chatId)).toEqual(['group:999'])
})

it('uses the same threshold at final recheck and resets after successful sending', async () => {
  const s = await setup()
  s.advance(25); s.activity()
  await vi.waitFor(() => expect(s.turns).toHaveLength(1))
  s.manager.startTurn('group:888'); s.manager.capture('group:888', '自然补充一句', false)
  s.activity(1)
  await s.manager.finish('group:888', true)
  expect(s.request).toHaveBeenCalledTimes(3)
  expect(s.sent).toEqual(['自然补充一句'])
  s.activity()
  await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(4))
  expect(s.turns).toHaveLength(1)
})

it('keeps willingness for an abandoned draft and clears it for a new session', async () => {
  const s = await setup()
  s.advance(25); s.activity()
  await vi.waitFor(() => expect(s.turns).toHaveLength(1))
  await s.manager.finish('group:888', false)
  s.activity(1)
  await vi.waitFor(() => expect(s.turns).toHaveLength(2))
  s.manager.reset('group:888'); s.activity()
  await vi.waitFor(() => expect(s.request).toHaveBeenCalledTimes(4))
  expect(s.turns).toHaveLength(2)
  expect(s.sent).toHaveLength(0)
})
