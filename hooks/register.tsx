import { atom, read, update } from 'claude-code'
import type { AgentStatus, Register } from 'claude-code'

import type { Agent, Main, Status, View } from '../types'
import { effortLabel, shortModel, treeRows } from './format'

const PANE = 'subagents-tree'
const TITLE = 'Subagents'

const agents = atom({ plugin: 'subagents-tree', key: 'agents' } as const, {} as Record<string, Agent>)
const main = atom({ plugin: 'subagents-tree', key: 'main' } as const, {} as Main)
const view = atom({ plugin: 'subagents-tree', key: 'view' } as const, { hideDone: false } as View)

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
  ...fields,
})

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

    // Once a second while anything runs: take statuses and agents this mod did not see
    // spawn from the engine's list.
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
      if (isFirst) await $.ui.open({ id: PANE, title: TITLE, placement: 'widget' })
    }
    await track().catch(quiet)

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const effort = e.effort === undefined ? undefined : String(e.effort)
    // Show the effort while the step runs, not only once it ends: a first step can take minutes.
    const stepId = e.agentId
    if (stepId !== undefined && effort !== undefined) {
      await update($, agents, patch(stepId, a => ({ ...a, effort }))).catch(quiet)
    }

    const response = yield* next(e)
    const model = response.usage?.model ?? e.model

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
        },
      }
    })

    return response
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const id = e.agentId
    if (id !== undefined) {
      const at = await $.clock.now()
      await update($, agents, patch(id, a => ({
        ...a,
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
    const inView = e.props.view.agentId
    const rows = treeRows(all, v.hideDone)

    const glyph = (a: Agent) =>
      a.status === 'running'
        ? { mark: '●', color: 'claude' }
        : a.status === 'completed'
          ? { mark: '✓', color: 'success' }
          : { mark: '✗', color: 'error' }

    return (
      <Box flexDirection="column">
        <Button key="main" plain onPress={() => $.ui.view({})}>
          <Text bold={inView === undefined}>{inView === undefined ? '▸ ' : '  '}main </Text>
          <Text color="claude">{shortModel(m.model)}</Text>
          <Text> </Text>
          <Text color="suggestion">{effortLabel(m.effort)}</Text>
        </Button>
        {rows.length === 0 && <Text dimColor>  No subagents yet.</Text>}
        {rows.map(({ agent: a, prefix }) => {
          const g = glyph(a)
          return (
            <Button key={`row-${a.id}`} plain onPress={() => $.ui.view({ agentId: a.id })}>
              <Text bold={inView === a.id}>{inView === a.id ? '▸' : ' '}{prefix}</Text>
              <Text color={g.color}>{g.mark} </Text>
              <Text color="claude">{shortModel(a.model)}</Text>
              <Text> </Text>
              <Text color="suggestion">{effortLabel(a.effort)}</Text>
              <Text dimColor wrap="truncate-end"> {a.type}</Text>
            </Button>
          )
        })}
        <Box marginTop={1}>
          <Button key="toggle-done" plain hotkey="h" onPress={() => update($, view, x => ({ ...x, hideDone: !x.hideDone }))}>
            {v.hideDone ? 'show done' : 'hide done'}
          </Button>
        </Box>
      </Box>
    )
  })
}
