import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutboundPipeline } from '../src/outbound.js'
import type { OutboundContext } from '../src/outbound.js'
import { Config } from '../src/index.js'
import { OneBotConnection } from '../src/connection.js'
import { WebSocketServer } from 'ws'
import { normalizeOneBot11 } from '../src/inbound.js'
import * as cards from '../src/t2i/index.js'
import { makeEvent, makeHarness } from './helpers/bridge-harness.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function outbound(threshold = 0) {
  const state = { connected: true }
  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  const ctx: OutboundContext = {
    getChat: () => undefined, connected: () => state.connected,
    selfId: () => '10002', isStopping: () => false, log: () => undefined,
    call: async (action, params) => { calls.push({ action, params }); return { message_id: 99 } },
    config: {
      botQQ: '10002', sensitivePatterns: [], textImageThreshold: threshold,
      maxImageBytes: 8 * 1024 * 1024, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
    },
  }
  return { pipeline: new OutboundPipeline(ctx), state, calls }
}

describe('QQ delivery integration', () => {
  it('preserves existing defaults while keeping poke opt-in', () => {
    expect(Config({})).toMatchObject({
      mode: 'reverse', newMessagePolicy: 'queue', interimRecall: true,
      sendErrorNotice: true, textImageThreshold: 150, allowPrivateHosts: false,
      maxQuoteDepth: 1, pokeEnabled: false,
    })
  })

  it('strips ACP metadata before sending while preserving URLs and ordinary tags', async () => {
    const h = outbound()
    await h.pipeline.sendToChat('private:10001', '<acp tokens="12" type="text" time="now">hello</acp>\nhttps://example.com\n<tag>keep</tag>')
    expect(h.calls[0].params.message).toEqual([
      { type: 'text', data: { text: 'hello\nhttps://example.com\n<tag>keep</tag>' } },
    ])
  })

  it('cleans direct text segments and drops segments left empty by ACP removal', async () => {
    const h = outbound()
    await h.pipeline.sendSegments('group:888', [
      { type: 'text', data: { text: '<acp tokens="1"> </acp>' } },
      { type: 'text', data: { text: 'tokens="12" type="text" time="now">m123hello' } },
      { type: 'image', data: { file: 'base64://aGVsbG8=' } },
    ])
    expect(h.calls[0].params.message).toEqual([
      { type: 'text', data: { text: 'hello' } },
      { type: 'image', data: { file: 'base64://aGVsbG8=' } },
    ])
  })

  it('does not send a message made entirely of ACP metadata', async () => {
    const h = outbound()
    await h.pipeline.sendToChat('private:10001', '<acp></acp>')
    expect(h.calls).toHaveLength(0)
  })

  it('turns a leading native reply marker into a QQ reply segment, including negative IDs', async () => {
    const h = outbound()
    await h.pipeline.sendToChat('group:888', ' \n[[reply:-123]] got it')
    expect(h.calls[0].params.message).toEqual([
      { type: 'reply', data: { id: '-123' } },
      { type: 'text', data: { text: 'got it' } },
    ])
  })

  it.each(['explain [[reply:123]] here', 'answer [[reply:777 directly', '[[reply:]] keep this'])('preserves prose or malformed reply syntax: %s', async text => {
    const h = outbound()
    await h.pipeline.sendToChat('private:10001', text)
    expect(h.calls[0].params.message).toEqual([{ type: 'text', data: { text } }])
  })

  it('keeps an explicit reply target ahead of a leading marker', async () => {
    const h = outbound()
    await h.pipeline.sendToChat('private:10001', '[[reply:123]] answer', { replyTo: '456' })
    expect(h.calls[0].params.message).toEqual([
      { type: 'reply', data: { id: '456' } }, { type: 'text', data: { text: 'answer' } },
    ])
  })

  it('cleans ACP before card rendering and attaches the native reply to the image', async () => {
    const render = vi.spyOn(cards, 'renderTextImage')
    const h = outbound(5)
    await h.pipeline.sendToChat('group:888', '[[reply:123]] <acp>this is a card reply</acp>')
    expect(render).toHaveBeenCalledWith('this is a card reply', expect.any(Object))
    expect(h.calls[0].params.message).toEqual([
      { type: 'reply', data: { id: '123' } },
      { type: 'image', data: { file: expect.stringMatching(/^base64:\/\//) } },
    ])
  }, 60_000)

  it('retains marker and explicit reply targets across reconnect delivery', async () => {
    const h = outbound()
    h.state.connected = false
    await h.pipeline.sendToChat('group:888', '[[reply:123]] first', { queuable: true })
    await h.pipeline.sendToChat('group:888', 'second', { queuable: true, replyTo: '-456' })
    expect(h.calls).toHaveLength(0)
    h.state.connected = true
    h.pipeline.drainPendingSends()
    await vi.waitFor(() => expect(h.calls).toHaveLength(2))
    expect(h.calls.map(call => (call.params.message as Array<{ data: unknown }>)[0].data)).toEqual([{ id: '123' }, { id: '-456' }])
  })

  it('preserves the original message timestamp and ID in private and group dispatch', async () => {
    const h = await makeHarness()
    try {
      const time = Math.floor(new Date(2026, 0, 2, 3, 4).getTime() / 1000)
      for (const kind of ['private', 'group']) {
        await h.bridge.handleInbound({
          post_type: 'message', message_type: kind, user_id: 10001, group_id: 888,
          self_id: 10002, message_id: -123, time,
          message: [...(kind === 'group' ? [{ type: 'at', data: { qq: '10002' } }] : []), { type: 'text', data: { text: 'hello' } }],
          sender: { nickname: 'Alice' },
        })
      }
      expect(h.captured.followups[0].text).toBe('[03:04] <user_message qq="10001" nickname="Alice" mid="-123">\nhello\n</user_message>')
      expect(h.captured.followups[1].text).toMatch(/^\[03:04 Alice\(10001\)·管理员\]\[@我\] <user_message qq="10001" nickname="Alice" mid="-123">/)
      expect(normalizeOneBot11({ message_type: 'private', user_id: 10001, time, message: 'hi' })?.time).toBe(time)
    } finally {
      h.client.close(); await h.bridge.stop(); await h.connection.stop()
    }
  })

  it('does not reuse a stopped admin role for a subsequent host-originated turn', async () => {
    const h = await makeHarness()
    try {
      await h.bridge.handleInbound({ post_type: 'message', message_type: 'private', user_id: 10001, message: 'hello' })
      await h.bridge.handleInbound({ post_type: 'message', message_type: 'private', user_id: 10001, message: '/stop' })
      h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
      expect(h.bridge.canEditFiles(h.sessionIds[0])).toBe(false)
    } finally {
      h.client.close(); await h.bridge.stop(); await h.connection.stop()
    }
  })

  it('probes a real reverse peer with get_status and remains connected on probe responses', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const h = await makeHarness()
    try {
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(h.outbound.some(frame => frame.action === 'get_status')).toBe(true))
      await h.connection.call('get_login_info', {})
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(h.outbound.filter(frame => frame.action === 'get_status')).toHaveLength(2))
      expect(h.connection.connected).toBe(true)
    } finally {
      vi.useRealTimers(); h.client.close(); await h.bridge.stop(); await h.connection.stop()
    }
  })

  it('probes a real forward peer and refreshes liveness from API responses', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const frames: Array<{ action?: string; echo?: string }> = []
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    server.on('connection', socket => socket.on('message', data => {
      const frame = JSON.parse(data.toString())
      frames.push(frame)
      socket.send(JSON.stringify({ status: 'ok', data: {}, echo: frame.echo }))
    }))
    await new Promise<void>(resolve => server.on('listening', resolve))
    const port = (server.address() as { port: number }).port
    const connection = new OneBotConnection({ mode: 'forward', url: 'ws://127.0.0.1:' + port, host: '127.0.0.1', port: 0, accessToken: '', callTimeoutMs: 3000 })
    try {
      connection.start()
      await vi.waitFor(() => expect(connection.connected).toBe(true))
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(frames.filter(frame => frame.action === 'get_status')).toHaveLength(1))
      // A real action round-trip fences the probe response before advancing time.
      await connection.call('get_login_info', {})
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(frames.filter(frame => frame.action === 'get_status')).toHaveLength(2))
      expect(connection.connected).toBe(true)
    } finally {
      await connection.stop()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
      vi.useRealTimers()
    }
  })
})
