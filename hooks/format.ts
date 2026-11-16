import type { Agent } from '../types'

export const shortModel = (model?: string) =>
  model === undefined ? '?' : model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

export const effortLabel = (effort?: string | number) => (effort === undefined ? '…' : String(effort))

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
