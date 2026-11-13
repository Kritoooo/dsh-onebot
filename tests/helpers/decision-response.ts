/** Fake only the remote decision provider; the scheduler and bridge stay real. */
export function answerRequest(init: RequestInit, overrides: Record<string, number | string> = {}): Response {
  const body = JSON.parse(String(init.body))
  const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key,
    (question as { type: string }).type === 'choice'
      ? { type: 'choice', choice: overrides[key] ?? 'helpful', probabilities: { helpful: 0.99 }, confidence: 0.99 }
      : { type: 'noul', noul: overrides[key] ?? (key === 'interruption' ? 0.01 : 0.99) },
  ]))
  return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 800, output_tokens: 90 } }))
}
