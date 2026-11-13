/**
 * Command-surface tests (M2-D1-PR1). Migrated from bridge.spec.ts per the
 * M2-T0 migration map §3.1, re-railed onto the shared tests/helpers stubs;
 * assertions are unchanged from the pre-split suite.
 * @module dsh-onebot/tests/commands
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { COMMANDS, helpText, packageVersion } from '../src/commands.js'
import { MediaStore } from '../src/media.js'
import { makeCmdHarness } from './helpers/bridge-harness.js'

describe('commands', () => {
  it('packageVersion resolves the fork version under ESM (no "?")', () => {
    expect(packageVersion()).toBe('0.9.19-kirito.3')
  })

  it('routes slash commands before the model: /new opens a fresh session', async () => {
    const h = await makeCmdHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const oldSession = h.sessionIds[0]
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    expect(h.captured.followups).toHaveLength(1) // /new never reaches the model
    h.sendText('第二条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].sessionId).not.toBe(oldSession)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('routes slash commands before the model: /stop cancels, unknown goes to the model', async () => {
    const h = await makeCmdHarness({ unknownCommand: 'passthrough' })
    h.sendText('启动任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    // Mark the agent running, then /stop must cancel it.
    const agent = (h.bridge as unknown as { chats: Map<string, { agent: { status: string; cancel: (c: unknown) => void } }> }).chats.get('private:10001')?.agent
    expect(agent).toBeDefined()
    agent!.status = 'running'
    h.sendText('/stop')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已停止生成'))).toBe(true)
    })
    expect(agent!.status).toBe('idle')
    expect(h.captured.followups).toHaveLength(1)
    // unknownCommand: 'passthrough' restores the pre-R1 fall-through to the model.
    h.sendText('/unknowncmd 参数')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].text).toContain('/unknowncmd')
    // A path is not a command.
    h.sendText('请查看 /tmp/x 文件')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('blocks slash commands for non-admin users', async () => {
    const h = await makeCmdHarness()
    // Group message from a non-admin member, @-mentioning the bot, with a
    // non-member-visible command (/status). /help is member-visible (T3-board)
    // and covered by its own test below.
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: 20002, group_id: 888, self_id: 10002,
      message: [
        { type: 'at', data: { qq: '10002' } },
        { type: 'text', data: { text: '/status' } },
      ],
      raw_message: '[CQ:at,qq=10002]/status',
      sender: { user_id: 20002, nickname: '路人' },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('仅管理员可用'))).toBe(true)
    })
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('renders the member /help card (memberVisible rows only) for a non-admin (T3-board)', async () => {
    const h = await makeCmdHarness()
    h.sendGroupTextAs('/help', 20002)
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可用命令：'))).toBe(true)
    })
    const card = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
    // /help itself is the only member-visible command so far: the member view
    // lists it and carries the 「其余命令需管理员」 tail.
    expect(card).toContain('/help 本帮助')
    expect(card).toContain('其余命令需管理员。')
    // Admin-only rows never leak into the member card.
    expect(card).not.toContain('/new ')
    expect(card).not.toContain('/silent ')
    expect(card).not.toContain('可用命令（仅管理员）：')
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('slash /new retires the chat agent and starts a fresh session on the next message', async () => {
    const h = await makeCmdHarness()
    // 1. Normal message lands on the first session.
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.sessionIds).toHaveLength(1)
    // 2. /new must NOT reach the agent; a confirmation is sent directly and
    //    the next message starts a fresh (suffixed) session.
    h.sendText('/new')
    await vi.waitFor(() => expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('已开启新会话'))).toBe(true))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendText('新对话的第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.sessionIds).toHaveLength(2)
    expect(h.sessionIds[1]).toMatch(/^onebot-private-10001-[a-z0-9]+$/)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /id /ver /status report the session state', async () => {
    const h = await makeCmdHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))

    h.sendText('/id')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('chat    : private:10001'))).toBe(true)
    })

    h.sendText('/ver')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('dsh-onebot v'))).toBe(true)
    })

    h.sendText('/status')
    await vi.waitFor(() => {
      const joined = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
      expect(joined).toContain('chat    : private:10001')
      expect(joined).toContain('model   : deepseek/deepseek-chat')
      expect(joined).toContain('preset  : （未记录）')
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /retry re-feeds the last user message; /new clears it', async () => {
    const h = await makeCmdHarness()
    h.sendText('第一次的问题')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('第一次的问题')

    h.sendText('/retry')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].text).toContain('第一次的问题')
    expect(h.captured.followups[1].sessionId).toBe(h.captured.followups[0].sessionId)

    // /new retires the chat agent; /retry then reports nothing to retry.
    h.sendText('/new')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('已开启新会话'))).toBe(true)
    })
    h.sendText('/retry')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('没有可重试'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('command messages carrying media skip media downloads (M1-C6a)', async () => {
    const h = await makeCmdHarness()
    const media = (h.bridge as unknown as { deps: { media: MediaStore } }).deps.media
    let downloads = 0
    const realDownload = media.downloadUrl.bind(media)
    media.downloadUrl = async (...args: Parameters<MediaStore['downloadUrl']>) => {
      downloads += 1
      return await realDownload(...args)
    }
    // '/help' text first so the message parses as a command; the attached
    // image must NOT be downloaded before the command consumes the message.
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [
        { type: 'text', data: { text: '/help ' } },
        { type: 'image', data: { url: 'http://127.0.0.1:1/a.png' } },
      ],
      raw_message: '/help [CQ:image,url=http://127.0.0.1:1/a.png]',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可用命令'))).toBe(true)
    })
    expect(downloads).toBe(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('slash /help lists the full routed command table for an admin (M2-T0 command table)', async () => {
    const h = await makeCmdHarness()
    h.sendText('/help')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可用命令'))).toBe(true)
    })
    const helpText = h.outbound.filter(f => f.action === 'send_msg').map(f => JSON.stringify(f.params)).join('\n')
    for (const name of ['new', 'stop', 'status', 'retry', 'id', 'ver', 'silent', 'mode', 'help']) {
      expect(helpText).toContain('/' + name)
    }
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('rejects every routed slash command for a non-admin with no side effects (M2-T0 command table)', async () => {
    const commands = { execute: vi.fn(async () => ({ kind: 'success', text: 'unreachable' })) }
    const h = await makeCmdHarness({ commands })
    for (const name of ['new', 'stop', 'status', 'retry', 'id', 'ver', 'silent', 'mode', ]) {
      const before = h.outbound.length
      h.sendGroupTextAs('/' + name, 20002)
      await vi.waitFor(() => {
        expect(h.outbound.slice(before).some(f => JSON.stringify(f.params).includes('仅管理员可用'))).toBe(true)
      })
      expect(h.outbound.slice(before).filter(f => f.action === 'send_msg')).toHaveLength(1)
    }
    expect(h.captured.followups).toHaveLength(0)
    expect(h.chats().size).toBe(0)
    expect(commands.execute).not.toHaveBeenCalled()
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('command table registers exactly the 11 routed commands, one row each, and /help renders the grouped card from the table (D1-PR1)', () => {
    // Row order = the /help line order inside each group; the router matches
    // by name so ordering is routing-neutral. Adding a command is exactly one
    // row here (group + usage-style help) — /help picks it up for free.
    // T3-board: /help carries memberVisible (the sole member-visible row).
    expect(COMMANDS.map(c => c.name)).toEqual(['new', 'stop', 'steer', 'status', 'doctor', 'retry', 'id', 'ver', 'silent', 'mode', 'help'])
    expect(COMMANDS).toHaveLength(11)
    expect(new Set(COMMANDS.map(c => c.name)).size).toBe(11)
    for (const c of COMMANDS) {
      expect(c.adminOnly).toBe(true)
      expect(c.help).not.toContain('\n')
      expect(c.help.trim()).not.toBe('')
      expect(c.group).toBeDefined()
    }
    expect(COMMANDS.filter(c => c.memberVisible === true).map(c => c.name)).toEqual(['help'])
    // Full-text snapshot gate: the grouped /help card, byte-exact (the
    // harness-level /help test above exercises the real outbound path).
    // Every routed command must appear exactly once in the card body.
    const card = helpText()
    expect(card).toBe([
      '可用命令（仅管理员）：',
      '▍会话',
      '/new 开启新会话（清空上下文）',
      '▍输出',
      '/mode [interim|instant] 出站模式（合并卡片/逐条即时）',
      '▍查询',
      '/status 会话全景',
      '/doctor [export [参考号]|test] 运行体检（export [参考号] 导出脱敏诊断包；test 一键自测收发链路）',
      '/id 会话标识（session/chat）',
      '/ver 插件版本',
      '▍操作',
      '/stop 停止当前生成',
      '/steer <补充内容> 向运行中的任务补充指令',
      '/retry 重跑上一条',
      '/silent [分钟] 临时免打扰（默认 30 分钟，期间普通消息被忽略；再次 /silent 提前解除）',
      '▍其他',
      '/help 本帮助',
      '',
      '未知命令默认拦截并提示相近命令；unknownCommand: passthrough 可改为透传给模型。',
    ].join('\n'))
    // T3-board: the member card lists ONLY memberVisible rows and swaps the
    // tail for 「其余命令需管理员」.
    const memberCard = helpText(true)
    expect(memberCard).toBe([
      '可用命令：',
      '▍其他',
      '/help 本帮助',
      '',
      '其余命令需管理员。',
      '未知命令默认拦截并提示相近命令；unknownCommand: passthrough 可改为透传给模型。',
    ].join('\n'))
    for (const c of COMMANDS) {
      expect(card.split('\n').filter(l => l.startsWith('/' + c.name + ' '))).toHaveLength(1)
    }
    // The alias never appears in /help (only the primary name is listed).
    expect(card).not.toContain('/healthcheck')
  })

  it('/healthcheck is an equivalent alias of /doctor: same handler, same output (T1 rename)', async () => {
    const h = await makeCmdHarness()
    h.sendText('/doctor')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('▍dsh-onebot 体检'))).toBe(true)
    }, { timeout: 15_000 })
    h.sendText('/healthcheck')
    await vi.waitFor(() => {
      expect(h.outbound.filter(f => JSON.stringify(f.params).includes('▍dsh-onebot 体检'))).toHaveLength(2)
    }, { timeout: 15_000 })
    // The alias was routed (two identical health summaries), not intercepted.
    expect(JSON.stringify(h.outbound)).not.toContain('未知命令')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('/doctor test sends a marker through the full outbound pipeline and reports success with latency (T3-board)', async () => {
    const h = await makeCmdHarness()
    h.sendText('/doctor test')
    await vi.waitFor(() => {
      // The marker itself is visible in the chat — receiving it IS the
      // success signal, so the self-test goes through sendToChat (production
      // posture), not a raw connection probe.
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('🧪 /doctor test 自测消息'))).toBe(true)
    })
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('✅ /doctor test 自测通过'))).toBe(true)
    })
    const report = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
    expect(report).toContain('连接：已连接')
    expect(report).toContain('发送：成功')
    expect(report).toContain('时延：')
    expect(report).toMatch(/时延：\d+ ms/)
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('/doctor test reports a send failure describeError-style without crashing the router (T3-board)', async () => {
    const h = await makeCmdHarness()
    const spy = vi.spyOn(h.bridge, 'sendToChat').mockRejectedValueOnce(new Error('boom: 链路炸了'))
    h.sendText('/doctor test')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('⚠️ /doctor test 自测失败'))).toBe(true)
    })
    const report = h.outbound.map(f => JSON.stringify(f.params)).join('\n')
    expect(report).toContain('连接：已连接')
    expect(report).toContain('发送：失败 — boom: 链路炸了')
    spy.mockRestore()
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('/silent: default 30-minute window drops normal messages, keeps commands, and lifts early (T3-board)', async () => {
    const h = await makeCmdHarness()
    h.sendText('/silent')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('🔇 已静音 30 分钟'))).toBe(true)
    })
    const afterSilent = h.outbound.length
    // Normal messages during the window are dropped silently: no reply and
    // no agent dispatch (the drop sits after command routing, before dispatch).
    h.sendText('静音期间的第一条')
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(h.captured.followups).toHaveLength(0)
    expect(h.outbound.length).toBe(afterSilent)
    // Slash commands still route inside the window.
    h.sendText('/help')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可用命令（仅管理员）'))).toBe(true)
    })
    // A bare /silent lifts the window early.
    h.sendText('/silent')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('🔔 已解除静音'))).toBe(true)
    })
    // Normal messages dispatch again after the lift.
    h.sendText('解除后的第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('/silent <分钟> sets a custom window, invalid input gets the usage line, and members cannot silence (T3-board)', async () => {
    const h = await makeCmdHarness()
    h.sendText('/silent 5')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('🔇 已静音 5 分钟'))).toBe(true)
    })
    // Out-of-range minutes get the usage line, not a window.
    h.sendText('/silent 0')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('分钟数无效'))).toBe(true)
    })
    h.sendText('/silent 99999')
    await vi.waitFor(() => {
      expect(h.outbound.filter(f => JSON.stringify(f.params).includes('分钟数无效'))).toHaveLength(2)
    })
    // Bracketed numbers are tolerated (same posture as /session).
    h.sendText('/silent [15]')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('🔇 已静音 15 分钟'))).toBe(true)
    })
    // A member cannot silence the chat: admin gate replies, and the group
    // chat keeps dispatching (silence state is per-chat and none was set).
    h.sendGroupTextAs('/silent', 20002)
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('仅管理员可用'))).toBe(true)
    })
    h.sendGroupTextAs('普通成员消息', 20002)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('unknown command with a close match suggests candidates and is consumed (R1)', async () => {
    const h = await makeCmdHarness()
    // Prefix match: /he is a prefix of /help (and of the /healthcheck alias of
    // /doctor — the alias suggests the primary name).
    h.sendText('/he')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('未知命令 /he，你是想用 /doctor（/help）吗？'))).toBe(true)
    })
    // Prefix match with several candidates, table order, max shown as /model（/mode）.
    h.sendText('/mo')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('你是想用 /mode吗？'))).toBe(true)
    })
    // Edit-distance fallback (input length ≥4): /vers ≈ /ver.
    h.sendText('/vers')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('你是想用 /ver吗？'))).toBe(true)
    })
    // Misspelling /helthcheck (distance 1 from the /healthcheck alias) still
    // suggests — mapped to the primary name /doctor.
    h.sendText('/helthcheck')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('未知命令 /helthcheck，你是想用 /doctor吗？'))).toBe(true)
    })
    // All three were consumed: none reached the model.
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('unknown command without a close match is intercepted by default (unknownCommand: intercept)', async () => {
    const h = await makeCmdHarness()
    h.sendText('/xyzw')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('未知命令 /xyzw。发 /help 查看命令列表'))).toBe(true)
    })
    // Inputs shorter than 4 never use the edit-distance fallback (/xy would be
    // distance 2 from /id), so they stay suggestion-less and just get the hint.
    h.sendText('/xy')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('未知命令 /xy。发 /help 查看命令列表'))).toBe(true)
    })
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('unknownCommand: passthrough restores the fall-through to the model (R1)', async () => {
    const h = await makeCmdHarness({ unknownCommand: 'passthrough' })
    h.sendText('/xyzw 参数')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('/xyzw')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('a path-like first token (/tmp/x) is not a command and still falls through under default intercept (R1)', async () => {
    const h = await makeCmdHarness()
    h.sendText('/tmp/x 不是命令')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('/tmp/x')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('non-admin unknown slash commands still hit the admin gate, not the suggestion path (R1 regression)', async () => {
    const h = await makeCmdHarness()
    // /hellp would suggest /help — but the admin gate runs first.
    h.sendGroupTextAs('/hellp', 20002)
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('仅管理员可用'))).toBe(true)
    })
    expect(h.outbound.some(f => JSON.stringify(f.params).includes('你是想用'))).toBe(false)
    expect(h.captured.followups).toHaveLength(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
