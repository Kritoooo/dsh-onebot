import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateReply } from '../src/decision.js'
import type { DecisionInput, DecisionProvider } from '../src/decision.js'
import { answerRequest } from './helpers/decision-response.js'

const input: DecisionInput = {
  botProfile: '会认真帮忙的群友', targetId: '123', continuation: false,
  botIdentity: { name: '群昵称', source: 'group-card', qq: '10002', qqNickname: '账号昵称', groupNickname: '群昵称' },
  messages: [{ id: '123', speaker: '2388274959', nickname: 'Alice', text: '有人知道怎么修吗？', at: 1, bot: false }],
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers() })

describe('native decision provider contract', () => {
  it.each([
    ['typesafe', 'https://api.typesafe.ai/v1/systemone', 'jev-1.14.0', 'TYPESAFE_API_KEY'],
    ['openrouter', 'https://openrouter.ai/api/alpha/decisions', 'typesafe/jev-1.14', 'OPENROUTER_API_KEY'],
    ['vercel', 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', 'typesafe-ai/jev', 'AI_GATEWAY_API_KEY'],
  ])('uses the documented native %s endpoint and questions', async (provider, endpoint, model, env) => {
    vi.stubEnv(env, 'test-decision-key')
    const request = vi.fn(async (_url: URL, init: RequestInit) => answerRequest(init))
    vi.stubGlobal('fetch', request)
    const result = await evaluateReply({ provider: provider as DecisionProvider, endpoint: '', model: '', apiKeyEnv: '', timeoutMs: 1_500 }, input)
    expect(String(request.mock.calls[0][0])).toBe(endpoint)
    const init = request.mock.calls[0][1]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-decision-key' })
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ model, state: { targetId: 'm0' }, questions: { addressed: { type: 'noul' }, mode: { type: 'choice' } } })
    expect(body.state.botIdentity).toMatchObject({ qq: '10002', qqNickname: '账号昵称', groupNickname: '群昵称' })
    expect(body.messages).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('2388274959')
    expect(result).toMatchObject({ addressed: 0.99, interruption: 0.01, relevantIds: ['123'], inputTokens: 800 })
  })

  it('uses a configured System One endpoint and native model without changing the payload', async () => {
    vi.stubEnv('CUSTOM_DECISION_KEY', 'custom-key')
    const request = vi.fn(async (_url: URL, init: RequestInit) => answerRequest(init))
    vi.stubGlobal('fetch', request)
    await evaluateReply({ provider: 'systemone', endpoint: 'https://decisions.example/v1/systemone', model: 'decision-model', apiKeyEnv: 'CUSTOM_DECISION_KEY', timeoutMs: 1_000 }, input)
    expect(String(request.mock.calls[0][0])).toBe('https://decisions.example/v1/systemone')
    expect(JSON.parse(String(request.mock.calls[0][1].body)).model).toBe('decision-model')
  })

  it.each([-0.1, 1.1, '0.99'])('rejects an invalid probability: %s', async value => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key')
    vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => answerRequest(init, { addressed: value }))
    await expect(evaluateReply({ provider: 'typesafe', endpoint: '', model: '', apiKeyEnv: '', timeoutMs: 1_000 }, input)).rejects.toThrow('有效概率')
  })

  it('rejects generated chat JSON instead of pretending it is a decision response', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key')
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":true}' } }] })))
    await expect(evaluateReply({ provider: 'typesafe', endpoint: '', model: '', apiKeyEnv: '', timeoutMs: 1_000 }, input)).rejects.toThrow('响应格式无效')
  })

  it('does not include the upstream error body in exceptions', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key')
    vi.stubGlobal('fetch', async () => new Response('secret echoed by upstream', { status: 401 }))
    await expect(evaluateReply({ provider: 'typesafe', endpoint: '', model: '', apiKeyEnv: '', timeoutMs: 1_000 }, input)).rejects.toThrow('HTTP 401')
  })

  it('aborts an unresponsive provider within its configured deadline', async () => {
    vi.useFakeTimers()
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key')
    vi.stubGlobal('fetch', (_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const outcome = evaluateReply({ provider: 'typesafe', endpoint: '', model: '', apiKeyEnv: '', timeoutMs: 100 }, input).catch(error => error)
    await vi.advanceTimersByTimeAsync(100)
    expect((await outcome).message).toBe('aborted')
  })

  it('does not send a credential to an insecure or credential-bearing endpoint', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    for (const endpoint of ['http://example.com/decide', 'https://user:password@example.com/decide']) {
      await expect(evaluateReply({ provider: 'systemone', endpoint, model: 'decision', apiKeyEnv: 'DECISION_KEY', timeoutMs: 100 }, input)).rejects.toThrow('HTTPS')
    }
    expect(request).not.toHaveBeenCalled()
  })
})
