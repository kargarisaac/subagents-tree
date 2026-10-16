export type Status = 'running' | 'completed' | 'failed' | 'killed'

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

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
  lastStepAt?: number
  tool?: { label: string; startedAt: number }
  context: number
  spent: Tokens
  steps: number
  tools: number
  files: string[]
}

export type Main = { model?: string; effort?: string; files: string[] }

export type View = { timeline: boolean; hideDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    fleet: {
      agents: Record<string, Agent>
      main: Main
      view: View
      now: number
    }
  }
}
