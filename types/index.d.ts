export type Status = 'running' | 'completed' | 'failed' | 'killed'

export type Agent = {
  id: string
  parentId?: string
  type: string
  description: string
  model?: string
  effort?: string
  status: Status
  startedAt: number
  endedAt?: number
}

export type Main = { model?: string; effort?: string }

export type View = { hideDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    'subagents-tree': {
      agents: Record<string, Agent>
      main: Main
      view: View
    }
  }
}
