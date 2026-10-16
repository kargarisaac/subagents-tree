import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'Subagents',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as never

type TestDollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

const mountPane = ($: TestDollar) =>
  $.ui.mount({ plugin: 'subagents-tree', surface: 'terminal', component: 'Pane', requestId: 'subagents-tree', props: PANE_PROPS } as never)

const usage = (model: string) => ({
  model,
  input_tokens: 10,
  output_tokens: 500,
  cache_read_input_tokens: 40_000,
  cache_creation_input_tokens: 2000,
})

const step = (agentId: string | undefined, effort: string, model: string) => ({
  turnId: 't1',
  index: 0,
  model,
  effort: effort as never,
  messageCount: 3,
  ...(agentId === undefined ? {} : { agentId }),
})

const runStep = async ($: TestDollar, input: ReturnType<typeof step>) => {
  const stream = $.turn.step(input)
  for await (const _ of stream) void _
  await stream.result
}

const textOf = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Button' })).map(b => b.text ?? '').join('\n')

test('main and each subagent row show their model and effort', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [] }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  let nextId = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: ['a1', 'a2'][nextId++] }) as never)
  on('turn.step', async function* (_$, e) {
    return {
      turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const,
      usage: usage(e.agentId === 'a1' ? 'claude-haiku-5-5' : 'claude-opus-5-5'),
    }
  })

  await $.agent.spawn({ prompt: 'p', description: 'find mods', subagentType: 'Explore' } as never)
  await $.agent.spawn({ prompt: 'p', description: 'deep research', subagentType: 'general-purpose' } as never)
  await runStep($, step(undefined, 'xhigh', 'claude-opus-5-5'))
  await runStep($, step('a1', 'max', 'claude-haiku-5-5'))
  await runStep($, step('a2', 'high', 'claude-opus-5-5'))

  const ui = await mountPane($)
  const text = await textOf(ui)

  expect(text).toContain('main opus-5-5 xhigh')
  expect(text).toContain('haiku-5-5 max')
  expect(text).toContain('Explore: find mods')
  expect(text).toContain('opus-5-5 high')
  expect(text).toContain('general-purpose: deep research')
})

test('a spawned agent shows its resolved model before its first step', async ($, on) => {
  mock.clock(on, { now: 5000 })
  on('agent.list', () => ({ value: [] }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }) as never)

  await $.agent.spawn({ prompt: 'p', description: 'early', subagentType: 'worker' } as never)

  const text = await textOf(await mountPane($))
  expect(text).toContain('sonnet-5-5 …')
})

test('a running tool shows under its agent and a finished agent keeps its row', async ($, on) => {
  const clock = mock.clock(on, { now: 5000 })
  on('agent.list', () => ({ value: [] }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }) as never)
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  on('tool.call', async () => {
    await held
    return { result: 'ok' } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)

  await $.agent.spawn({ prompt: 'p', description: 'grep things', subagentType: 'Explore' } as never)
  const call = $.tool.call({ tool: 'Grep', pattern: 'live pane', tool_use_id: 'tu1', agentId: 'a1' } as never)
  await clock.advance(0)

  const ui = await mountPane($)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
  expect(texts.join(' | ')).toContain('⎿ Grep /live pane/')

  release()
  await call
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 10, isAborted: false, agentId: 'a1' } as never)
  await ui.redraw()

  const text = await textOf(ui)
  expect(text).toContain('✓')
  expect(text).toContain('1 tools')
  expect(text).toContain('haiku-5-5')
})

test('an agent spawned by a subagent is drawn nested under it', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  on('agent.list', () => ({
    value: [
      { id: 'p1', type: 'general-purpose', description: 'lead', status: 'running' },
      { id: 'c1', type: 'worker', description: 'fetch docs', status: 'running', parentId: 'p1' },
      { id: 'c2', type: 'worker', description: 'fetch readme', status: 'completed', parentId: 'p1' },
    ],
  }) as never)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', () => ({ cwd: '/x' }) as never)

  await $.session.start({ cwd: '/x', surface: 'terminal' } as never)
  await clock.advance(1000)

  const text = await textOf(await mountPane($))
  expect(text).toMatch(/^ └─● .*general-purpose: lead$/m)
  expect(text).toMatch(/^   ├─● .*worker: fetch docs$/m)
  expect(text).toMatch(/^   └─✓ .*worker: fetch readme$/m)
})
