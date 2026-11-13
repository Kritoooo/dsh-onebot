import { describe, expect, it } from 'vitest'
import { OutboundPipeline } from '../src/outbound.js'

function outbound() {
  const state = { connected: true }
  const sent: unknown[] = []
  const pipeline = new OutboundPipeline({
    getChat: () => undefined, connected: () => state.connected, selfId: () => '10002',
    isStopping: () => false, log: () => undefined,
    call: async (_action, params) => { sent.push(params); return { message_id: sent.length } },
    config: { botQQ: '10002', sensitivePatterns: [], textImageThreshold: 1,
      maxImageBytes: 1_000, cardFooter: 'dsh', fontFiles: [], fontFamilies: [], actionAuditEnabled: false },
  })
  return { pipeline, state, sent }
}

describe('proactive final-send boundary', () => {
  it('checks validity after waiting in the send queue', async () => {
    const h = outbound()
    let valid = true
    const sending = h.pipeline.sendProactive('group:888', '已经过时', () => valid)
    valid = false
    expect(await sending).toBeUndefined()
    expect(h.sent).toHaveLength(0)
  })

  it('does not park a disconnected proactive reply for reconnect', async () => {
    const h = outbound()
    h.state.connected = false
    expect(await h.pipeline.sendProactive('group:888', '旧回复', () => true)).toBeUndefined()
    h.state.connected = true
    h.pipeline.drainPendingSends()
    await h.pipeline.chainTail('group:888')
    expect(h.sent).toHaveLength(0)
  })

  it('sends one text message even above the configured image threshold', async () => {
    const h = outbound()
    await h.pipeline.sendProactive('group:888', '这是一条纯文本主动回复。', () => true)
    expect(h.sent).toEqual([{ group_id: 888, message: [{ type: 'text', data: { text: '这是一条纯文本主动回复。' } }] }])
  })
})
