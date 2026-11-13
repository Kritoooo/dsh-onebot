import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { makeHarness } from './helpers/bridge-harness.js'
import type { QuotedMessageData } from '../src/inbound.js'
import { Config } from '../src/index.js'

const PHOTO = Buffer.from('ffd8ffe0001002', 'hex')
const STICKER = Buffer.from('47494638396101', 'hex')
const image = (bytes = PHOTO, extra = {}) => ({ type: 'image', data: { file: 'base64://' + bytes.toString('base64'), ...extra } })
const reply = { type: 'reply', data: { id: '123' } }
const atBot = { type: 'at', data: { qq: '10002' } }
const body = { type: 'text', data: { text: '这张图是什么？' } }
const open: Awaited<ReturnType<typeof makeHarness>>[] = []

afterEach(async () => {
  for (const h of open.splice(0)) {
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
    await rm(h.mediaDir, { recursive: true, force: true })
  }
})

async function quoted(data: QuotedMessageData | ((id: number) => QuotedMessageData), message: unknown[] = [reply, atBot, body], maxQuoteDepth?: number) {
  const getMsg = vi.fn((params: Record<string, unknown>) => typeof data === 'function' ? data(params.message_id as number) : data)
  const h = await makeHarness({ maxQuoteDepth, respond: { get_msg: getMsg } })
  open.push(h)
  h.client.send(JSON.stringify({
    post_type: 'message', message_type: 'group', user_id: 10001, group_id: 888, self_id: 10002,
    message, sender: { user_id: 10001, nickname: '提问者' },
  }))
  await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
  return { h, getMsg, text: h.captured.followups[0].text }
}

async function imageBytes(text: string) {
  return Promise.all([...text.matchAll(/\[(?:图片|表情包):([^\]]+)\]/g)].map(m => readFile(m[1])))
}

describe('quoted images through the OneBot bridge', () => {
  it('resolves a pure quoted image and reuses a verified bot-author lookup', async () => {
    const { text, getMsg } = await quoted({ message: [image()], sender: { user_id: 10002, nickname: '机器人' } }, [reply, body])
    expect(text).toContain('[引用]机器人: [图片:')
    expect(await imageBytes(text)).toEqual([PHOTO])
    expect(getMsg).toHaveBeenCalledExactlyOnceWith({ message_id: 123 })
  })

  it('keeps quoted text, stickers and multiple photos in source order', async () => {
    const { text } = await quoted({
      message: [{ type: 'text', data: { text: '原文 &amp; 内容' } }, image(STICKER, { sub_type: '1' }), image()],
      sender: { nickname: '群友' },
    })
    expect(text).toContain('[引用]群友: 原文 & 内容[表情包:')
    expect(await imageBytes(text)).toEqual([STICKER, PHOTO])
    expect(text).toContain('这张图是什么？')
  })

  it.each(['raw_message', 'message'] as const)('resolves CQ image strings from %s', async field => {
    const { text } = await quoted({ [field]: '原文[CQ:image,file=base64://' + PHOTO.toString('base64') + ']' })
    expect(text).toContain('[引用]原文[图片:')
    expect(await imageBytes(text)).toEqual([PHOTO])
  })

  it.each([
    { url: 'http://127.0.0.1:1/private-image.png' },
    { file: 'file:///etc/passwd' },
  ])('keeps a placeholder when quoted media is refused by existing guards: %j', async data => {
    const { text } = await quoted({ message: [{ type: 'image', data }] })
    expect(text).toContain('[引用][图片]')
    expect(text).not.toContain('[图片:')
    expect(text).toContain('这张图是什么？')
  })

  it('does not recursively fetch quoted replies or forwards', async () => {
    const { text, getMsg, h } = await quoted({ message: [reply, image(), { type: 'forward', data: { id: 'nested' } }] })
    expect(getMsg).toHaveBeenCalledTimes(1)
    expect(await imageBytes(text)).toEqual([PHOTO])
    expect(h.outbound.some(frame => frame.action === 'get_forward_msg')).toBe(false)
  })

  it('disables quote expansion at depth 0 without dropping an explicit mention', async () => {
    const { text, getMsg } = await quoted({ message: [image()] }, undefined, 0)
    expect(getMsg).not.toHaveBeenCalled()
    expect(await imageBytes(text)).toEqual([])
    expect(text).toContain('这张图是什么？')
  })

  it('expands only the configured two levels, retaining images at both levels', async () => {
    const { text, getMsg } = await quoted(id => ({
      message: [{ type: 'text', data: { text: '原文' + id } }, image(), { type: 'reply', data: { id: String(id + 1) } }],
    }), undefined, 2)
    expect(getMsg.mock.calls.map(([params]) => params.message_id)).toEqual([123, 124])
    expect(text).toContain('[引用·第2层]原文124')
    expect(text).not.toContain('原文125')
    expect(text).toContain('[引用已达层数上限]')
    expect(await imageBytes(text)).toEqual([PHOTO, PHOTO])
  })

  it('stops cyclic IDs before another lookup or download, including equivalent numeric IDs', async () => {
    const { text, getMsg } = await quoted(id => ({
      message: [image(), { type: 'reply', data: { id: id === 123 ? '124' : '00123' } }],
    }), undefined, 5)
    expect(getMsg.mock.calls.map(([params]) => params.message_id)).toEqual([123, 124])
    expect(text).toContain('[引用循环已停止]')
    expect(await imageBytes(text)).toEqual([PHOTO, PHOTO])
  })

  it('retains the outer quote and current message when a deeper lookup fails', async () => {
    const { text, getMsg } = await quoted(id => {
      if (id !== 123) throw new Error('message deleted')
      return { message: [image(), { type: 'reply', data: { id: '124' } }] }
    }, undefined, 3)
    expect(getMsg).toHaveBeenCalledTimes(2)
    expect(await imageBytes(text)).toEqual([PHOTO])
    expect(text).toContain('这张图是什么？')
  })

  it('enforces the five-level ceiling even for a caller bypassing schema validation', async () => {
    const { getMsg } = await quoted(id => ({ message: [{ type: 'reply', data: { id: String(id + 1) } }] }), undefined, 999)
    expect(getMsg).toHaveBeenCalledTimes(5)
  })

  it('validates the configurable depth as an integer from 0 through 5', () => {
    expect(Config({}).maxQuoteDepth).toBe(1)
    for (const maxQuoteDepth of [0, 2, 5]) expect(Config({ maxQuoteDepth }).maxQuoteDepth).toBe(maxQuoteDepth)
    for (const maxQuoteDepth of [-1, 1.5, 6, '2', Infinity]) expect(() => Config({ maxQuoteDepth })).toThrow()
  })
})
