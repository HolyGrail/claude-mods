// A notice this session has passed on to the model: its id, and its text for the withdrawal line
export type NoticeBoardKnown = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'notice-board': { known: NoticeBoardKnown[] }
  }
}
