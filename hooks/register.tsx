import { atom, read, update } from 'claude-code'
import type { AgentStatus, Register } from 'claude-code'

import type { Agent, Main, Status, View } from '../types'
import {
  bar,
  collisions,
  duration,
  effortLabel,
  emptyTokens,
  isStalled,
  kilo,
  shortModel,
  spentOf,
  toolLabel,
  treeRows,
  writtenFile,
} from './format'

const PANE = 'subagents-tree'
const TITLE = 'Subagents'

const agents = atom({ plugin: 'subagents-tree', key: 'agents' } as const, {} as Record<string, Agent>)
const main = atom({ plugin: 'subagents-tree', key: 'main' } as const, { files: [] } as Main)
const view = atom({ plugin: 'subagents-tree', key: 'view' } as const, { timeline: true, hideDone: false } as View)
const now = atom({ plugin: 'subagents-tree', key: 'now' } as const, 0)

const statusOf = (s: AgentStatus): Status =>
  s === 'completed' || s === 'failed' || s === 'killed' ? s : 'running'

const patch = (id: string, fn: (a: Agent) => Agent) => (all: Record<string, Agent>) =>
  all[id] === undefined ? all : { ...all, [id]: fn(all[id]) }

const fresh = (id: string, at: number, fields: Partial<Agent>): Agent => ({
  id,
  type: 'agent',
  description: '',
  status: 'running',
  startedAt: at,
  context: 0,
  spent: emptyTokens(),
  steps: 0,
  tools: 0,
  files: [],
  ...fields,
})

const addFile = (files: string[], file?: string) =>
  file === undefined || files.includes(file) ? files : [...files, file]

// Drops keys rather than storing `undefined`, which state values do not carry.
const omit = <K extends keyof Agent>(a: Agent, ...keys: K[]): Agent => {
  const copy = { ...a }
  for (const k of keys) delete copy[k]
  return copy
}

// The dashboard's bookkeeping never fails the event it watches.
const quiet = () => undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'subagents', description: 'Show every subagent of this session in a docked pane' }).catch(quiet)

    // Once a second while anything runs: move the clock the pane draws with and take
    // statuses and agents this mod did not see spawn from the engine's list.
    $.clock.every(1000, async () => {
      const known = await read($, agents)
      const list = await $.agent.list()
      const isBusy = list.some(a => statusOf(a.status) === 'running') ||
        Object.values(known).some(a => a.status === 'running')
      if (!isBusy) return
      const at = await $.clock.now()
      await update($, agents, all => {
        const merged = { ...all }
        for (const info of list) {
          const status = statusOf(info.status)
          const was = merged[info.id]
          if (was === undefined) {
            merged[info.id] = fresh(info.id, at, {
              ...(info.parentId === undefined ? {} : { parentId: info.parentId }),
              type: info.type,
              description: info.description,
              status,
              ...(status === 'running' ? {} : { endedAt: at }),
            })
          } else if (was.status !== status && (status !== 'running' || was.endedAt === undefined)) {
            merged[info.id] = { ...was, status, ...(status === 'running' ? {} : { endedAt: was.endedAt ?? at }) }
          }
        }
        return merged
      })
      await update($, now, () => at)
    })

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, placement: 'widget' })
    return { text: 'Subagents pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = result.agentId
    if (id === undefined) return result

    const track = async () => {
      const at = await $.clock.now()
      const isFirst = Object.keys(await read($, agents)).length === 0
      await update($, agents, all => ({
        ...all,
        [id]: fresh(id, at, {
          ...(e.parentAgentId === undefined ? {} : { parentId: e.parentAgentId }),
          type: e.subagentType,
          description: e.description,
          model: result.model,
        }),
      }))
      await update($, now, () => at)
      if (isFirst) await $.ui.open({ id: PANE, title: TITLE, placement: 'widget' })
    }
    await track().catch(quiet)

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const usage = response.usage
    const model = usage?.model ?? e.model
    const effort = e.effort === undefined ? undefined : String(e.effort)

    if (e.agentId === undefined) {
      await update($, main, m => ({ ...m, model, effort: effort ?? m.effort }))
      return response
    }

    const at = await $.clock.now()
    const id = e.agentId
    await update($, agents, all => {
      const was = all[id] ?? fresh(id, at, {})
      return {
        ...all,
        [id]: {
          ...omit(was, 'endedAt'),
          model,
          ...(effort ?? was.effort) === undefined ? {} : { effort: effort ?? was.effort },
          status: 'running' as const,
          lastStepAt: at,
          steps: was.steps + 1,
          context: usage
            ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
            : was.context,
          spent: usage
            ? {
                input: was.spent.input + usage.input_tokens,
                output: was.spent.output + usage.output_tokens,
                cacheRead: was.spent.cacheRead + usage.cache_read_input_tokens,
                cacheWrite: was.spent.cacheWrite + usage.cache_creation_input_tokens,
              }
            : was.spent,
        },
      }
    })

    return response
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const file = writtenFile(e.tool, args)

    if (e.agentId === undefined) {
      if (file !== undefined) await update($, main, m => ({ ...m, files: addFile(m.files, file) })).catch(quiet)
      return next(e)
    }

    const id = e.agentId
    const begin = async () => {
      const at = await $.clock.now()
      await update($, agents, patch(id, a => ({ ...a, tool: { label: toolLabel(e.tool, args), startedAt: at } })))
    }
    await begin().catch(quiet)
    try {
      return await next(e)
    } finally {
      await update($, agents, patch(id, a => ({ ...omit(a, 'tool'), tools: a.tools + 1, files: addFile(a.files, file) }))).catch(quiet)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const id = e.agentId
    if (id !== undefined) {
      const at = await $.clock.now()
      await update($, agents, patch(id, a => ({
        ...omit(a, 'tool'),
        status: e.isAborted ? 'killed' : 'completed',
        endedAt: at,
      })))
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, agents)

    // Widget (minimized pane, e.g. in the desktop session rail): only name, model and effort.
    if (e.props.placement === 'widget') {
      const list = Object.values(all)
      return (
        <Box flexDirection="column">
          {list.length === 0 && <Text dimColor>No subagents yet.</Text>}
          {list.map(a => (
            <Text key={a.id} wrap="truncate-end" dimColor={a.status !== 'running'}>
              {a.type}: {a.description} <Text color="claude">{shortModel(a.model)}</Text>{' '}
              <Text color="suggestion">{effortLabel(a.effort)}</Text>
            </Text>
          ))}
        </Box>
      )
    }

    const m = await read($, main)
    const v = await read($, view)
    const clock = Math.max(await read($, now), ...Object.values(all).map(a => a.endedAt ?? a.lastStepAt ?? a.startedAt))
    const cost = (await $.session.usage().catch(quiet))?.cost?.usd
    const width = Math.max(20, e.props.bodyColumns)
    const inView = e.props.view.agentId

    const list = Object.values(all)
    const running = list.filter(a => a.status === 'running').length
    const spent = list.reduce((sum, a) => sum + spentOf(a.spent), 0)
    const rows = treeRows(all, v.hideDone)
    const clashes = collisions(all, m)

    const glyph = (a: Agent) =>
      isStalled(a, clock)
        ? { mark: '◌', color: 'warning' }
        : a.status === 'running'
          ? { mark: '●', color: 'claude' }
          : a.status === 'completed'
            ? { mark: '✓', color: 'success' }
            : { mark: '✗', color: 'error' }

    const header = [
      `${running} running`,
      `${list.length - running} done`,
      `${kilo(spent)} tok`,
      ...(cost === undefined ? [] : [`$${cost.toFixed(2)} session`]),
    ].join(' · ')

    const start = Math.min(clock, ...list.map(a => a.startedAt))
    const label = 10
    const lane = Math.max(4, width - label - 1)

    return (
      <Box flexDirection="column">
        <Text dimColor>{header}</Text>
        <Button key="main" plain onPress={() => $.ui.view({})}>
          <Text bold={inView === undefined}>{inView === undefined ? '▸ ' : '  '}main </Text>
          <Text color="claude">{shortModel(m.model)}</Text>
          <Text> </Text>
          <Text color="suggestion">{effortLabel(m.effort)}</Text>
        </Button>
        {rows.length === 0 && <Text dimColor>  No subagents yet.</Text>}
        {rows.map(({ agent: a, prefix }) => {
          const g = glyph(a)
          const elapsed = duration((a.endedAt ?? clock) - a.startedAt)
          const tokens = a.status === 'running'
            ? `ctx ${kilo(a.context)}`
            : `${kilo(spentOf(a.spent))} · ${a.tools} tools`
          const toolFor = a.tool === undefined ? undefined : duration(clock - a.tool.startedAt)
          return (
            <Box key={a.id} flexDirection="column">
              <Button key={`row-${a.id}`} plain onPress={() => $.ui.view({ agentId: a.id })}>
                <Text bold={inView === a.id}>{inView === a.id ? '▸' : ' '}{prefix}</Text>
                <Text color={g.color}>{g.mark} </Text>
                <Text color="claude">{shortModel(a.model)}</Text>
                <Text> </Text>
                <Text color="suggestion">{effortLabel(a.effort)}</Text>
                <Text dimColor> {elapsed} {tokens} </Text>
                <Text wrap="truncate-end">{a.type}: {a.description}</Text>
              </Button>
              {a.tool !== undefined && (
                <Text dimColor wrap="truncate-end">
                  {' '}{prefix.replace(/[├└]─$/, prefix.endsWith('└─') ? '  ' : '│ ')}  ⎿ {a.tool.label} {toolFor}
                </Text>
              )}
              {isStalled(a, clock) && (
                <Text color="warning">{'   '}no step for {duration(clock - (a.lastStepAt ?? a.startedAt))}</Text>
              )}
            </Box>
          )
        })}
        {v.timeline && rows.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>timeline {'─'.repeat(Math.max(0, width - 13))} now</Text>
            {rows.map(({ agent: a, depth }) => (
              <Box key={`lane-${a.id}`}>
                <Text dimColor>{`${' '.repeat(depth)}${a.type}`.slice(0, label).padEnd(label)} </Text>
                <Text color={a.status === 'running' ? 'claude' : 'inactive'}>{bar(a, start, clock, lane)}</Text>
              </Box>
            ))}
          </Box>
        )}
        {clashes.map(c => (
          <Text key={`clash-${c.file}`} color="warning" wrap="truncate-end">
            ⚠ {c.count} loops wrote {c.file.split('/').slice(-3).join('/')}
          </Text>
        ))}
        <Box marginTop={1} gap={2}>
          <Button key="toggle-timeline" plain hotkey="t" onPress={() => update($, view, x => ({ ...x, timeline: !x.timeline }))}>
            timeline
          </Button>
          <Button key="toggle-done" plain hotkey="h" onPress={() => update($, view, x => ({ ...x, hideDone: !x.hideDone }))}>
            {v.hideDone ? 'show done' : 'hide done'}
          </Button>
        </Box>
      </Box>
    )
  })
}
