export type View = {
  cold: boolean
  ageMin: number
  /** Minutes until the next keep-warm ping; null when away or the ping budget is spent. */
  nextPingMin: number | null
  away: boolean
  /** Whether the session may hand over and clear on its own (/autoclear). */
  autoclear: boolean
  tokens: number
  tokenLimit: number
  turns: number
  turnLimit: number
  isWriting: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-keeper': { view: View | null; phase: string }
  }
}
