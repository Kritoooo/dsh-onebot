import { mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMANDS, helpText } from '../src/commands.js'
import { Config, inject } from '../src/index.js'
import { SETTINGS_GROUPS, SCHEMA_DEFAULTS } from '../src/settings-remote.js'
import { makeHarness } from './helpers/bridge-harness.js'

const removed = ['goal', 'plan', 'permission', 'workspace', 'model', 'preset', 'session', 'ocr']
const removedFlags = ['recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun', 'injectIntervalMs']

describe('QQ channel scope', () => {
  it('exposes the retained commands and omits the removed commands from help', () => {
    expect(COMMANDS.map(command => command.name)).toEqual(['new', 'stop', 'steer', 'status', 'doctor', 'retry', 'id', 'ver', 'silent', 'mode', 'help'])
    for (const command of removed) expect(helpText()).not.toMatch(new RegExp('^/' + command + '\\b', 'm'))
    expect(inject).not.toContain('commands')
    expect(inject).not.toContain('llm')
  })

  it.each(removed)('does not execute /%s or create a model session for it', async command => {
    const h = await makeHarness()
    try {
      await h.bridge.handleInbound({ post_type: 'message', message_type: 'private', user_id: 10001, message: '/' + command })
      expect(h.captured.followups).toHaveLength(0)
      expect(h.sessionIds).toHaveLength(0)
      expect(JSON.stringify(h.outbound)).toContain('未知命令')
    } finally {
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    }
  })

  it('keeps ordinary replies as messages and registers only the QQ media/API tools', async () => {
    const h = await makeHarness()
    try {
      for (const text of ['1', '答: 选第一个', '跳过']) {
        await h.bridge.handleInbound({ post_type: 'message', message_type: 'private', user_id: 10001, message: text })
      }
      expect(h.captured.followups).toHaveLength(3)
      expect(h.captured.followups.map(message => message.text)).toEqual([
        expect.stringContaining('\n1\n'), expect.stringContaining('\n答: 选第一个\n'), expect.stringContaining('\n跳过\n'),
      ])
      expect(h.captured.channelTools).toEqual(['qq_send_image', 'qq_send_voice', 'qq_send_video', 'qq_send_file', 'qq_send_forward', 'qq_send_segments', 'qq_napcat_api', 'qq_group_history'])
    } finally {
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    }
  })

  it('retains configured model assembly, presets and workspace while removing debug controls', () => {
    expect(Config({ agentPreset: 'qq-chat', agentPresetGroup: 'group-chat', workspacePath: '/tmp/qq-workspace' })).toMatchObject({
      agentPreset: 'qq-chat', agentPresetGroup: 'group-chat', workspacePath: '/tmp/qq-workspace',
    })
    const fields = Object.values(SETTINGS_GROUPS).flat()
    for (const flag of removedFlags) {
      expect(fields).not.toContain(flag)
      expect(SCHEMA_DEFAULTS).not.toHaveProperty(flag)
    }
    expect(SETTINGS_GROUPS.diagnostics).toEqual(['actionAuditEnabled', 'traceEnabled'])
  })

  it('ignores legacy goals and workspace overrides but preserves current-session recovery and remaining settings', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'qq-scope-legacy-'))
    const mapping = join(mediaDir, 'chat-sessions.json')
    await writeFile(mapping, JSON.stringify({
      'private:10001': {
        session: 'onebot-private-10001', goal: 'LEGACY_GOAL_MUST_NOT_LEAK',
        workspacePath: '/tmp/obsolete-override', interimOverride: false,
      },
    }))
    const h = await makeHarness({ mediaDir, resumeOk: true })
    try {
      await h.bridge.handleInbound({ post_type: 'message', message_type: 'private', user_id: 10001, message: 'hello' })
      expect(h.sessionIds).toEqual(['onebot-private-10001'])
      expect(h.captured.followups).toHaveLength(1)
      expect(h.captured.followups[0].text).not.toContain('LEGACY_GOAL_MUST_NOT_LEAK')
      await h.bridge.stop()
      const saved = JSON.parse(await readFile(mapping, 'utf8'))
      expect(saved['private:10001']).toEqual({ session: 'onebot-private-10001', interimOverride: false })
    } finally {
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    }
  })
})
