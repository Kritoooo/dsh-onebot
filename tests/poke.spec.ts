import { describe, expect, it, vi } from 'vitest'
import { createPokeHandler } from '../src/poke.js'
import type { OneBotEvent } from '../src/connection.js'
import { makeHarness } from './helpers/bridge-harness.js'

const notice = (overrides: Partial<OneBotEvent> = {}): OneBotEvent => ({
  post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
  user_id: 10001, target_id: 10002, self_id: 10002, ...overrides,
})

describe('poke notices', () => {
  it.each([false, true])('respects pokeEnabled=%s', enabled => {
    const dispatch = vi.fn()
    createPokeHandler({ pokeEnabled: enabled, selfId: () => '10002', dispatch })(notice())
    expect(dispatch).toHaveBeenCalledTimes(enabled ? 1 : 0)
  })

  it.each([
    { target_id: 99999 }, { target_id: undefined }, { user_id: 10002 },
    { user_id: undefined }, { post_type: 'message' }, { notice_type: 'group_increase' },
  ])('ignores an unrelated or unverifiable notice: %j', overrides => {
    const dispatch = vi.fn()
    createPokeHandler({ pokeEnabled: true, selfId: () => '10002', dispatch })(notice(overrides))
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch while the bot identity is unknown', () => {
    const dispatch = vi.fn()
    createPokeHandler({ pokeEnabled: true, selfId: () => '', dispatch })(notice())
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('throttles by chat and sender, allowing another poke after 3 seconds', () => {
    let at = 100_000
    const dispatch = vi.fn()
    const handle = createPokeHandler({ pokeEnabled: true, selfId: () => '10002', dispatch, now: () => at })
    handle(notice({ group_id: 888 }))
    handle(notice({ group_id: 888 }))
    handle(notice({ group_id: 889 }))
    handle(notice({ group_id: 888, user_id: 20002 }))
    expect(dispatch).toHaveBeenCalledTimes(3)
    at += 2_999
    handle(notice({ group_id: 888 }))
    expect(dispatch).toHaveBeenCalledTimes(3)
    at++
    handle(notice({ group_id: 888 }))
    expect(dispatch).toHaveBeenCalledTimes(4)
  })

  it.each(['poke', 'notify'])('routes %s over real WebSocket and passes the group mention gate', async noticeType => {
    const h = await makeHarness()
    try {
      h.connection.onNotice = createPokeHandler({
        pokeEnabled: true, selfId: () => h.connection.selfId,
        dispatch: event => { void h.bridge.handleInbound(event) },
      })
      h.client.send(JSON.stringify(notice({ notice_type: noticeType, group_id: 888 })))
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
      expect(h.captured.followups[0].text).toContain('[@我]')
      expect(h.captured.followups[0].text).toContain('[戳一戳]')
      expect(h.captured.followups[0].text).not.toContain('mid=')
    } finally {
      h.client.close(); await h.bridge.stop(); await h.connection.stop()
    }
  })

  it('applies the existing private whitelist to generated inbound events', async () => {
    const h = await makeHarness()
    try {
      const pending: Promise<void>[] = []
      const handle = createPokeHandler({
        pokeEnabled: true, selfId: () => '10002',
        dispatch: event => { pending.push(h.bridge.handleInbound(event)) },
      })
      handle(notice({ user_id: 20002 }))
      await Promise.all(pending)
      expect(h.captured.followups).toHaveLength(0)
      handle(notice())
      await Promise.all(pending)
      expect(h.captured.followups).toHaveLength(1)
    } finally {
      h.client.close(); await h.bridge.stop(); await h.connection.stop()
    }
  })
})
