/**
 * Mapping-file settings persistence tests (M3-D4b): /mode (/mode → interimOverride)
 * and /goal survive a restart through the chat-sessions.json mapping. The
 * format is additive — a legacy entry is a bare chat→session-id string; an
 * entry with persisted settings becomes { session, interimOverride?, goal? }.
 * Covers: command-setter wiring → debounced write → restart round-trip, the
 * legacy-file fallback, and the idle-eviction snapshot cycle.
 * @module dsh-onebot/tests/mapping-settings
 */
import { describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { OneBotConnection } from '../src/connection.js'
import { ChatBridge } from '../src/bridge.js'
import { ChatRegistry } from '../src/registry.js'
import type { RegistryDeps } from '../src/registry.js'
import type { BridgeConfig } from '../src/bridge.js'
import { MediaStore } from '../src/media.js'
import { Transcriber } from '../src/stt.js'

import { makeFakeAgents, makeHarness } from './helpers/bridge-harness.js'

/** Registry-only view of a harness-built bridge (same convention as registry.spec). */
function registryOf(h: { bridge: unknown }): ChatRegistry {
  return (h.bridge as unknown as { registry: ChatRegistry }).registry
}

/** Minimal RegistryDeps for direct-registry tests (same convention as registry.spec). */
function makeRegistryDeps(overrides?: {
  agents?: unknown
  config?: Partial<Pick<BridgeConfig, 'mediaDir' | 'workspacePath' | 'agentPreset' | 'restrictedMemberPrefix' | 'maxImageBytes' | 'maxVoiceBytes' | 'maxFileBytes' | 'chatIdleEvictDays'>>
}): RegistryDeps {
  return {
    agents: (overrides?.agents ?? { create: vi.fn(), resume: vi.fn() }) as never,
    sessions: { flush: vi.fn(async () => undefined) } as never,
    sessionPersistence: undefined,
    workspaceRegistry: undefined as never,
    agentPresets: {
      defaultId: 'standard',
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
      mount: vi.fn(async (_agentCtx: unknown, id?: string) => ({ id: id ?? 'standard' })),
    } as never,
    defaultModel: undefined,
    config: {
      mediaDir: mkdtemp(),
      workspacePath: '',
      agentPreset: '',
      restrictedMemberPrefix: false,
      maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024,
      maxFileBytes: 20 * 1024 * 1024,
      ...overrides?.config,
    },
    log: () => undefined,
    isStopping: () => false,
    onChatRemoved: () => undefined,
    installChannelScope: () => undefined,
  }
}

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), 'onebot-test-'))
}

describe('mapping-file settings persistence (M3-D4b)', () => {

  it('loadMapping accepts a legacy mapping file and falls back to the current defaults', async () => {
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured, { resumeOk: true })
    const deps = makeRegistryDeps({ agents })
    // Old format: bare chat→session strings, no settings fields at all.
    await writeFile(join(deps.config.mediaDir, 'chat-sessions.json'), JSON.stringify({
      'private:10001': 'onebot-private-10001',
      'private:10002': { session: 'onebot-private-10002', goal: '只带目标的条目' },
    }), 'utf8')
    const registry = new ChatRegistry(deps)
    await registry.loadMapping()
    // Both shapes resume without crashing.
    expect(registry.chats.get('private:10001')?.sessionId).toBe('onebot-private-10001')
    expect(registry.chats.get('private:10002')?.sessionId).toBe('onebot-private-10002')
    // Legacy chat: no settings on file → the current defaults apply.
    expect(registry.getSettings('private:10001').interimOverride).toBeUndefined()
    expect(registry.getSettings('private:10001')).not.toHaveProperty('goal')
    // Removed goal state is ignored even in a legacy object entry.
    expect(registry.getSettings('private:10002')).not.toHaveProperty('goal')
    expect(registry.getSettings('private:10002').interimOverride).toBeUndefined()
    await registry.stop()
  })
})

describe('T3: workspacePath persistence + default directory (方案 B)', () => {

  it('keeps the bare-string entry byte-identical when no settings are persisted', async () => {
    const sessionIds: string[] = []
    const deps = makeRegistryDeps({ agents: makeFakeAgents(sessionIds, { followups: [] }, { resumeOk: true }) })
    const registry = new ChatRegistry(deps)
    await registry.ensureChat('private:10001', '小明')
    await registry.saveMapping()
    const text = await readFile(join(deps.config.mediaDir, 'chat-sessions.json'), 'utf8')
    expect(text).toBe('{\n  "private:10001": "' + sessionIds[0] + '"\n}')
    await registry.stop()
  })

  it('falls back to the host process cwd when unconfigured (方案 B default dir)', () => {
    const deps = makeRegistryDeps()
    const registry = new ChatRegistry(deps)
    expect(registry.effectiveCwd('private:10001')).toBe(process.cwd())
    expect(registry.effectiveCwd()).toBe(process.cwd())
  })
})

describe('T3-R1 review closure: retired-entry and collision-heal settings carriers', () => {

  it('healSessionCollision without persisted settings keeps the pre-T3 drop behavior (helper parity with resetChat)', async () => {
    const deps = makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: true }) })
    const registry = new ChatRegistry(deps)
    await registry.ensureChat('private:10001', '小明')
    await registry.healSessionCollision('private:10001')
    await registry.saveMapping()
    const mapping = JSON.parse(await readFile(join(deps.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, unknown>
    expect(mapping['private:10001']).toBeUndefined()
    await registry.stop()
  })
})

describe('silence-window persistence (T3-board /silent)', () => {
  it('persists /silent through the command accessor and re-arms the window after a restart', async () => {
    const mediaDir = mkdtemp()
    const h = await makeHarness({ mediaDir })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendText('/silent 30')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('🔇 已静音 30 分钟'))).toBe(true)
    })
    // The debounced write lands the window in the mapping (additive field).
    await vi.waitFor(async () => {
      const mapping = JSON.parse(await readFile(join(mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; silentUntil?: number }>
      const entry = mapping['private:10001']
      expect(typeof entry).toBe('object')
      expect(typeof (entry as { silentUntil?: number }).silentUntil).toBe('number')
      expect((entry as { silentUntil: number }).silentUntil).toBeGreaterThan(Date.now())
    }, { timeout: 10_000 })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()

    // A fresh bridge over the same mediaDir re-arms the running window: a
    // normal message is dropped, and a bare /silent reports the lift (the
    // lift branch only fires when a window is open).
    const h2 = await makeHarness({ mediaDir })
    await vi.waitFor(() => {
      expect(registryOf(h2).getSettings('private:10001').silentUntil).toBeGreaterThan(Date.now())
    })
    h2.sendText('重启后的普通消息')
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(h2.captured.followups).toHaveLength(0)
    h2.sendText('/silent')
    await vi.waitFor(() => {
      expect(h2.outbound.some(f => JSON.stringify(f.params).includes('🔔 已解除静音'))).toBe(true)
    })
    // The lift clears the durable copy too (debounced save drops the field).
    await vi.waitFor(async () => {
      const mapping = JSON.parse(await readFile(join(mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; silentUntil?: number }>
      expect(mapping['private:10001']?.silentUntil).toBeUndefined()
    }, { timeout: 10_000 })
    h2.client.close()
    await h2.bridge.stop()
    await h2.connection.stop()
  }, 30_000)

  it('loadMapping drops an expired silentUntil (a restart never re-arms a stale mute)', async () => {
    const sessionIds: string[] = []
    const deps = makeRegistryDeps({ agents: makeFakeAgents(sessionIds, { followups: [] }, { resumeOk: true }) })
    await writeFile(join(deps.config.mediaDir, 'chat-sessions.json'), JSON.stringify({
      'private:10001': { session: 'onebot-private-10001', silentUntil: Date.now() - 1000 },
      'private:10002': { session: 'onebot-private-10002', silentUntil: Date.now() + 60_000 },
    }), 'utf8')
    const registry = new ChatRegistry(deps)
    await registry.loadMapping()
    expect(registry.getSettings('private:10001').silentUntil).toBeUndefined()
    expect(registry.getSettings('private:10002').silentUntil).toBeGreaterThan(Date.now())
    // The open window is visible to the bridge's rehydration probe.
    expect(registry.silenceWindows()).toEqual([{ chatId: 'private:10002', until: expect.any(Number) }])
    await registry.stop()
  })

  it('persistEntry keeps the bare-string shape when only an expired silence window is set', async () => {
    const sessionIds: string[] = []
    const deps = makeRegistryDeps({ agents: makeFakeAgents(sessionIds, { followups: [] }, { resumeOk: true }) })
    const registry = new ChatRegistry(deps)
    await registry.ensureChat('private:10001', '小明')
    registry.getSettings('private:10001').silentUntil = Date.now() - 1
    await registry.saveMapping()
    const text = await readFile(join(deps.config.mediaDir, 'chat-sessions.json'), 'utf8')
    expect(text).toBe('{\n  "private:10001": "' + sessionIds[0] + '"\n}')
    await registry.stop()
  })
})
