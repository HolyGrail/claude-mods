// What version 0.1 kept of the notices it passed on to the model: an id, and the text. Read once
// per session.start to recognise that version's unsigned rows; never written.
export type NoticeBoardKnown = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'notice-board': { known: NoticeBoardKnown[] }
  }
}
