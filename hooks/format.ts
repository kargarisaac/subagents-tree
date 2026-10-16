import type { Agent, Main, Tokens } from '../types'

export const STALL_MS = 90_000

export const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export const shortModel = (model?: string) =>
  model === undefined ? '?' : model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

export const effortLabel = (effort?: string | number) => (effort === undefined ? '…' : String(effort))

export const kilo = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

// Tokens the agent paid for fresh: new input, cache writes and output; cache reads are left out.
export const spentOf = (t: Tokens) => t.input + t.cacheWrite + t.output

const text = (v: unknown) => (typeof v === 'string' ? v : undefined)

const tail = (path: string) => path.split('/').slice(-2).join('/')

export const toolLabel = (tool: string, args: Record<string, unknown>) => {
  const path = text(args.file_path) ?? text(args.notebook_path) ?? text(args.path)
  switch (tool) {
    case 'Bash':
      return `$ ${text(args.command) ?? ''}`
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${tool} ${path === undefined ? '' : tail(path)}`
    case 'Grep':
      return `Grep /${text(args.pattern) ?? ''}/${path === undefined ? '' : ` in ${tail(path)}`}`
    case 'Glob':
      return `Glob ${text(args.pattern) ?? ''}`
    case 'WebFetch':
      return `WebFetch ${(text(args.url) ?? '').replace(/^https?:\/\//, '')}`
    case 'WebSearch':
      return `WebSearch ${text(args.query) ?? ''}`
    case 'Agent':
      return `spawn ${text(args.subagent_type) ?? 'agent'}: ${text(args.description) ?? ''}`
    default:
      return tool
  }
}

export const writtenFile = (tool: string, args: Record<string, unknown>) =>
  tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit'
    ? (text(args.file_path) ?? text(args.notebook_path))
    : undefined

export const isStalled = (a: Agent, now: number) =>
  a.status === 'running' && a.tool === undefined && now - (a.lastStepAt ?? a.startedAt) > STALL_MS

export type Row = { agent: Agent; prefix: string; depth: number }

// Depth-first rows; an agent whose parent is unknown hangs under main.
export const treeRows = (agents: Record<string, Agent>, hideDone: boolean): Row[] => {
  const visible = Object.values(agents).filter(a => !hideDone || a.status === 'running')
  const ids = new Set(visible.map(a => a.id))
  const children = new Map<string | undefined, Agent[]>()
  for (const a of visible) {
    const parent = a.parentId !== undefined && ids.has(a.parentId) ? a.parentId : undefined
    children.set(parent, [...(children.get(parent) ?? []), a])
  }
  const rows: Row[] = []
  const walk = (parent: string | undefined, indent: string, depth: number) => {
    const kids = (children.get(parent) ?? []).sort((x, y) => x.startedAt - y.startedAt)
    kids.forEach((a, i) => {
      const last = i === kids.length - 1
      rows.push({ agent: a, prefix: `${indent}${last ? '└─' : '├─'}`, depth })
      walk(a.id, `${indent}${last ? '  ' : '│ '}`, depth + 1)
    })
  }
  walk(undefined, '', 0)
  return rows
}

// Files written by more than one loop (main counts as one).
export const collisions = (agents: Record<string, Agent>, main: Main) => {
  const owners = new Map<string, Set<string>>()
  const add = (who: string, files: string[]) => {
    for (const f of files) owners.set(f, (owners.get(f) ?? new Set()).add(who))
  }
  add('main', main.files)
  for (const a of Object.values(agents)) add(a.id, a.files)
  return [...owners].filter(([, who]) => who.size > 1).map(([file, who]) => ({ file, count: who.size }))
}

export const bar = (a: Agent, start: number, now: number, width: number) => {
  const span = Math.max(1, now - start)
  const from = Math.floor(((a.startedAt - start) / span) * width)
  const to = Math.ceil((((a.endedAt ?? now) - start) / span) * width)
  const lead = Math.min(width - 1, Math.max(0, from))
  return ' '.repeat(lead) + '█'.repeat(Math.max(1, Math.min(width, to) - lead))
}
