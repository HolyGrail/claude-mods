import type { ModelCompleteResult, ModelForkResult } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'

const MINUTE = 60_000
// 14:00 in Tokyo, the zone the setup's TZ names so the times expected below hold on any machine
const NOW = Date.UTC(2026, 10, 18, 5)
const FILE = '/home/me/.claude/projects/work/s1.jsonl'

type On = Parameters<typeof mock.clock>[0]
type Engine = Parameters<TestBody>[0]
type Surface = 'terminal' | 'desktop'

const BAND = {
  plugin: 'status-board',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const PANE = {
  plugin: 'status-board',
  component: 'Pane',
  requestId: 'status-board',
  props: { title: '状況ボード', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// /board as the person types it
const COMMAND = { command: 'board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

type Host = {
  files: Map<string, Uint8Array>
  transcriptPath: string
  reads: { path: string; offset: number; length: number }[]
  panes: string[]
  placed: boolean
  toasts: string[]
  // What the status line shows, and how many more fs.read calls fail
  status: string | undefined
  failReads: number
  failStats: number
  // The conversation's id, $.store, the forks asked for and how the next one answers; a fork
  // waits on `hold` while it is set
  sessionId: string
  store: Map<string, unknown>
  forks: string[]
  reply: ModelForkResult
  hold?: Promise<void>
  // The proofreading asks ($.model.complete) and how the next one answers, waiting on
  // `proofHold` while it is set; the folders $.fs.list and $.fs.stat know, by path
  completes: { model: string; prompt: unknown; maxTokens?: number; timeoutMs?: number }[]
  proofReply: ModelCompleteResult
  proofHold?: Promise<void>
  // Set, the engine refuses the call with this
  proofDeny?: string
  dirs: Map<string, { name: string; kind: 'file' | 'dir' | 'other'; isLink?: boolean }[]>
  // The /board descriptions registered, one per session.start, and the titles panes opened with
  commands: string[]
  titles: string[]
  // What decides the locale: the `language` setting, the locale variables, and whether reading
  // the settings fails
  language: string | undefined
  env: Record<string, string>
  settingsFail: boolean
  // A settings read waits on this while it is set
  settingsHold?: Promise<void>
}

// The tests below run under Claude Code's `language` setting `japanese` unless they say otherwise,
// so the assertions on Japanese text are the Japanese locale's coverage; the English ones set
// `language: undefined`
function stubHost(on: On, files: Record<string, string> = {}, locale: Partial<Pick<Host, 'language' | 'env' | 'settingsFail'>> = {}): Host {
  const h: Host = {
    files: new Map(Object.entries(files).map(([path, text]) => [path, utf8(text)])),
    transcriptPath: FILE,
    reads: [],
    panes: [],
    placed: true,
    toasts: [],
    status: undefined,
    failReads: 0,
    failStats: 0,
    sessionId: 's1',
    store: new Map(),
    forks: [],
    reply: answered('## 目的\n- 帯を直す'),
    completes: [],
    proofReply: answered('') as ModelCompleteResult,
    dirs: new Map(),
    commands: [],
    titles: [],
    language: 'japanese',
    settingsFail: false,
    ...locale,
    // Times are drawn in TZ's zone: Tokyo unless a test names another
    env: { TZ: 'Asia/Tokyo', ...locale.env },
  }
  on('settings.read', async () => {
    if (h.settingsHold) await h.settingsHold
    return h.settingsFail ? { deny: 'settings unreadable' } : { value: h.language === undefined ? {} : { language: h.language } }
  })
  on('env.get', ($, e) => ({ value: h.env[e.name] }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: h.sessionId }))
  on('store.get', ($, e) => ({ value: h.store.get(e.key) }))
  on('store.set', ($, e) => {
    h.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    h.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...h.store.keys()] }))
  on('model.fork', async ($, e) => {
    h.forks.push(e.prompt)
    if (h.hold) await h.hold
    return { value: h.reply }
  })
  on('model.complete', async ($, e) => {
    h.completes.push({ model: e.model, prompt: e.promptBlocks ?? e.prompt, maxTokens: e.maxTokens, timeoutMs: e.timeoutMs })
    if (h.proofHold) await h.proofHold
    if (h.proofDeny) return { deny: h.proofDeny }
    return { value: h.proofReply }
  })
  on('fs.list', ($, e) => {
    const entries = h.dirs.get(e.path)
    if (!entries) return { deny: `ENOENT: no such file or directory, scandir '${e.path}'` }
    return { value: entries.map((entry) => ({ size: 0, mtimeMs: 0, isLink: false, ...entry })) }
  })
  on('session.info', () => ({ value: { transcriptPath: h.transcriptPath } }))
  on('command.register', ($, e) => {
    h.commands.push(e.description ?? '')
    return { value: { command: 'board' } }
  })
  on('classic.SessionStart', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('fs.stat', ($, e) => {
    if (h.failStats > 0) {
      h.failStats -= 1
      return { deny: 'EACCES: permission denied' }
    }
    if (h.dirs.has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    const bytes = h.files.get(e.path)
    if (!bytes) return { deny: `ENOENT: no such file or directory, lstat '${e.path}'` }
    return { value: { kind: 'file', size: bytes.length, mtimeMs: 0, isLink: false } }
  })
  // Byte ranges, as the engine reads them
  on('fs.read', ($, e) => {
    if (h.failReads > 0) {
      h.failReads -= 1
      return { deny: 'EACCES: permission denied\nsecond line' }
    }
    const bytes = h.files.get(e.path)
    if (!bytes) throw new Error(`ENOENT: ${e.path}`)
    const offset = e.offset ?? 0
    const slice = bytes.subarray(offset, e.length === undefined ? undefined : offset + e.length)
    h.reads.push({ path: e.path, offset, length: slice.length })
    if (e.as === 'text') return { value: new TextDecoder().decode(slice) }
    return { value: { base64: base64(slice) } }
  })
  on('ui.panes', () => ({ value: h.panes.map((id) => ({ id, title: id, isShown: true, isFocused: false, isPlaced: h.placed })) }))
  on('ui.open', ($, e) => {
    h.titles.push(e.title ?? '')
    if (!h.panes.includes(e.id)) h.panes.push(e.id)
    return { value: h.placed ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' } }
  })
  on('ui.close', ($, e) => {
    h.panes = h.panes.filter((id) => id !== e.id)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    h.status = e.text
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    h.toasts.push(e.text)
    return { value: undefined }
  })
  // What the mods after this one draw in the band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))
  return h
}

// A fork's answer, with the usage measured on the desktop app
function answered(text: string): ModelForkResult {
  return {
    isAnswered: true,
    text,
    usage: { input_tokens: 378, cache_read_input_tokens: 321_578, cache_creation_input_tokens: 685, output_tokens: 490 },
  } as ModelForkResult
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function append(h: Host, path: string, text: string) {
  const before = h.files.get(path) ?? new Uint8Array()
  const added = utf8(text)
  const out = new Uint8Array(before.length + added.length)
  out.set(before, 0)
  out.set(added, before.length)
  h.files.set(path, out)
}

// ---------------------------------------------------------------- transcript rows

let uuids = 0
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * MINUTE).toISOString()

function prompt(text: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  return (
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: text },
      uuid: `u${++uuids}`,
      timestamp: iso(minutesAgo),
      promptSource: 'sdk',
      origin: { kind: 'human' },
      ...extra,
    }) + '\n'
  )
}

function toolUse(name: string, input: unknown, minutesAgo: number, id: string, extra: Record<string, unknown> = {}) {
  return (
    JSON.stringify({
      parentUuid: 'p',
      isSidechain: false,
      type: 'assistant',
      uuid: `a${++uuids}`,
      timestamp: iso(minutesAgo),
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
      ...extra,
    }) + '\n'
  )
}

const plan = (input: unknown, minutesAgo: number, id = `toolu_plan_${++uuids}`) => toolUse('mcp__ccd_turn__update_plan', input, minutesAgo, id)
const wrap = (input: unknown, minutesAgo: number, id = `toolu_wrap_${++uuids}`) => toolUse('mcp__ccd_turn__wrap_up', input, minutesAgo, id)

function prLink(number: number, minutesAgo: number, repository = 'o/r', scheme = 'https') {
  return (
    JSON.stringify({
      type: 'pr-link',
      sessionId: 's1',
      prNumber: number,
      prUrl: `${scheme}://github.com/${repository}/pull/${number}`,
      prRepository: repository,
      timestamp: iso(minutesAgo),
    }) + '\n'
  )
}

const items = (...steps: [string, string][]) => ({ items: steps.map(([content, status]) => ({ content, status })) })

// ---------------------------------------------------------------- drawing

type Node = string | { type: string; props?: Record<string, unknown>; children?: Node[] }

function textOf(node: Node | undefined): string {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string') return node
  const children = node.children ?? (node.props?.children as Node[] | undefined) ?? []
  // A Button drawn from its label has no children
  if (children.length === 0 && typeof node.props?.label === 'string') return node.props.label
  return children.map(textOf).join('')
}

function childrenOf(node: Node): Node[] {
  if (typeof node === 'string') return []
  return node.children ?? (node.props?.children as Node[] | undefined) ?? []
}

async function start($: Engine, clock: ReturnType<typeof mock.clock>, surface: Surface = 'desktop') {
  await $.session.start({ cwd: '/work', surface, isInteractive: true })
  await clock.settle()
}

type Mounted = Pick<Awaited<ReturnType<Engine['ui']['mount']>>, 'find' | 'press' | 'drawn'>

// What the pane draws under its history button, with the history shown
async function historyOf(ui: Mounted): Promise<Node[]> {
  const button = await ui.find({ key: 'status-board-history' })
  if (button?.text === '履歴を表示' || button?.text === 'Show history') await ui.press({ key: 'status-board-history' })
  const top = childrenOf((await ui.drawn()) as Node)
  const at = top.findIndex((child) => typeof child !== 'string' && child.props?.key === 'status-board-history')
  return top.slice(at + 1)
}

const asText = (child: Node) => (typeof child !== 'string' && child.type === 'Box' ? childrenOf(child).map(textOf) : textOf(child))

// The pane's history as text, newest card first: a card is the text of each of its lines,
// anything else (the button that shows more) its text; the line said with nothing at all alone
async function paneCards($: Engine, surface: Surface = 'desktop') {
  const ui = await $.ui.mount({ ...PANE, surface })
  const drawn = (await ui.drawn()) as Node
  if (typeof drawn === 'string' || drawn.type !== 'Box') {
    await ui.unmount()
    return [textOf(drawn)]
  }
  const history = await historyOf(ui)
  await ui.unmount()
  return history.map(asText)
}

// The board part of the pane: its Markdown, the line under it, the button and the failure
async function boardOf($: Engine, surface: Surface = 'desktop') {
  const ui = await $.ui.mount({ ...PANE, surface })
  const markdown = await ui.find({ type: 'Markdown' })
  const button = await ui.find({ key: 'status-board-refresh' })
  const lines = (await ui.findAll({ type: 'Text' })).map((found) => found.text)
  await ui.unmount()
  return {
    markdown: markdown?.props.text as string | undefined,
    meta: lines.find((line) => line.includes('時点') || line.startsWith('As of ')),
    button: button?.text,
    error: lines.find((line) => line.startsWith('要約できませんでした') || line.startsWith('Could not summarize')),
    proofError: lines.find((line) => line.startsWith('校正できませんでした') || line.startsWith('Could not proofread')),
  }
}

async function openPane($: Engine, clock: ReturnType<typeof mock.clock>) {
  await $.command.run(COMMAND)
  await clock.settle()
}

// The band's own line, or undefined when it draws none
async function bandLine($: Engine, surface: Surface = 'desktop', bodyColumns = 100) {
  const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns } })
  const line = await ui.find({ key: 'status-board' })
  const other = await ui.find({ type: 'Text', text: 'drawn by another mod' })
  await ui.unmount()
  return { line: line && textOf(line as unknown as Node), other: other !== undefined }
}

async function completeTurn($: Engine, clock: ReturnType<typeof mock.clock>) {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.settle()
}

// ---------------------------------------------------------------- tests

test('derives prompts without the engine\'s reminders, plans, steps, recaps, questions and linked pull requests, leaving out subagent rows and system input', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubHost(on, {
    [FILE]:
      prompt('ログを\n調べて', 30) +
      prompt('plugin が差し込んだ文', 29, { promptSource: 'system', origin: undefined }) +
      prompt('meta の行', 29, { isMeta: true }) +
      // An input not marked as typed by a person counts when the last-prompt row names it
      JSON.stringify({ type: 'last-prompt', lastPrompt: '<system-reminder>r</system-reminder>別セッションからの指示', leafUuid: 'u-relayed' }) + '\n' +
      prompt('別セッションからの指示', 28, { uuid: 'u-relayed', origin: undefined }) +
      prompt('名指しされない入力', 28, { origin: undefined }) +
      // The engine's reminders are not what the person typed: a leading block, a span in a string,
      // and a prompt that holds nothing else
      prompt('', 27.5, {
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>' },
            { type: 'text', text: '最初の入力' },
          ],
        },
      }) +
      prompt('前<system-reminder>\n注意\n</system-reminder>後', 27.4) +
      prompt('<system-reminder>だけ</system-reminder>', 27.3) +
      plan(items(['サブエージェントの計画', 'in_progress']), 27).replace('"isSidechain":false', '"isSidechain":true') +
      plan(items(['読む', 'in_progress'], ['直す', 'pending']), 26) +
      toolUse('AskUserQuestion', { questions: [{ question: 'どちらにしますか?' }, { question: '次は?' }] }, 25, 'toolu_ask') +
      prLink(12, 24) +
      // The desktop app writes the same link again
      prLink(12, 23) +
      wrap({ recap: '読み終えた', ask: '直しますか?', blocked: true }, 22) +
      toolUse('Bash', { command: 'ls' }, 21, 'toolu_bash'),
  })
  await start($, clock)

  expect(await paneCards($)).toEqual([
    [
      '○ 13:32 前後',
      '● 13:35 質問 どちらにしますか?（ほか 1 問）',
      '○ 13:38 読み終えた',
      '質問: 直しますか?',
      '● 進行中 (1/2) 読む',
      '計画 2 ステップ · PR #12',
    ],
    ['○ 13:32 最初の入力'],
    ['○ 13:32 別セッションからの指示'],
    ['○ 13:30 ログを 調べて'],
  ])
})

test('replays update_plan: items, advance, done and start, and a wrap-up that completes the plan unless blocked', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('直して', 20) + plan(items(['読む', 'in_progress'], ['直す', 'pending'], ['試す', 'pending']), 19) })
  await start($, clock)
  expect((await bandLine($)).line).toBe('● 進行中 (1/3) 読む · 13:41状況ボード')

  // One advance finishes a step and starts the next at the same moment
  append(h, FILE, plan({ advance: true }, 15))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('● 進行中 (2/3) 直す · 13:45状況ボード')

  append(h, FILE, plan({ done: [2], start: 3 }, 10))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('● 進行中 (3/3) 試す · 13:50状況ボード')

  // A blocked wrap-up waits for an answer: the step stays in progress
  append(h, FILE, wrap({ recap: '確認待ち', blocked: true }, 8))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('● 進行中 (3/3) 試す · 13:50状況ボード')

  // Otherwise the plan is done with no step events of its own, and a new list is a fresh plan
  append(h, FILE, wrap({ recap: '終わった' }, 5))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('○ まとめ 終わった · 13:55状況ボード')
  append(h, FILE, plan(items(['次の作業', 'pending'], ['仕上げ', 'pending']), 4))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('● 計画を作成: 2 ステップ · 13:56状況ボード')
  append(h, FILE, plan(items(['次の作業', 'pending'], ['別の仕上げ', 'pending']), 3))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('● 計画を更新: 2 ステップ · 13:57状況ボード')
  // The card folds the plans and steps: the last plan's size and the two steps completed
  expect(await paneCards($)).toEqual([['○ 13:40 直して', '○ 13:52 確認待ち', '○ 13:55 終わった', '計画 2 ステップ · 完了 2']])
})

test('reads only what was appended, holds a line cut mid-character until the rest arrives, and rereads a file that shrank', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const first = prompt('最初', 10)
  const h = stubHost(on, { [FILE]: first })
  await start($, clock)
  expect(h.reads).toEqual([{ path: FILE, offset: 0, length: utf8(first).length }])

  // The file ends inside 日 (three bytes) of an unfinished line
  const second = utf8(prompt('日本語の指示', 5))
  // Just past the first byte of 日
  const cut = second.findIndex((b) => b >= 0x80) + 1
  h.files.set(FILE, new Uint8Array([...utf8(first), ...second.subarray(0, cut)]))
  await completeTurn($, clock)
  expect(h.reads.at(-1)).toEqual({ path: FILE, offset: utf8(first).length, length: cut })
  expect(await paneCards($)).toEqual([['○ 13:50 最初']])

  h.files.set(FILE, new Uint8Array([...utf8(first), ...second]))
  await completeTurn($, clock)
  expect(h.reads.at(-1)).toEqual({ path: FILE, offset: utf8(first).length + cut, length: second.length - cut })
  expect(await paneCards($)).toEqual([['○ 13:55 日本語の指示'], ['○ 13:50 最初']])

  // Rewritten shorter: read from the start, with nothing of what was there before
  h.files.set(FILE, utf8(prompt('書き直し', 1)))
  await completeTurn($, clock)
  expect(await paneCards($)).toEqual([['○ 13:59 書き直し']])
})

test('waits for a transcript the engine has not written yet, and reads a turn\'s rows while it runs', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  await start($, clock)
  expect(await paneCards($)).toEqual(['まだ記録はありません。指示や計画がここに並びます。'])
  expect((await bandLine($)).line).toBeUndefined()

  await $.turn.start({ text: 'やって', turnId: 't' })
  // The prompt row lands a moment after the turn starts
  h.files.set(FILE, utf8(prompt('やって', 0)))
  await clock.advance(300)
  expect(await paneCards($)).toEqual([['○ 14:00 やって']])

  append(h, FILE, plan(items(['作業', 'in_progress']), 0))
  await clock.advance(2_000)
  expect(await paneCards($)).toEqual([['○ 14:00 やって', '● 進行中 (1/1) 作業', '計画 1 ステップ']])
})

test('says in the status line when the transcript cannot be read three times in a row, until a read succeeds', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('読める', 1) })
  h.failReads = 3
  await start($, clock)
  await completeTurn($, clock)
  expect(h.status).toBeUndefined()

  await completeTurn($, clock)
  expect(h.status).toBe('status-board: 会話ログを読めません: status-board: $.fs.read: EACCES: permission denied')

  await completeTurn($, clock)
  expect(h.status).toBeUndefined()
  expect(await paneCards($)).toEqual([['○ 13:59 読める']])
})

test('/resume switches to the resumed conversation\'s transcript', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const other = '/home/me/.claude/projects/work/s0.jsonl'
  const h = stubHost(on, { [FILE]: prompt('今の会話', 5), [other]: prompt('再開した会話', 2 * 24 * 60) })
  await start($, clock)
  expect(await paneCards($)).toEqual([['○ 13:55 今の会話']])

  h.transcriptPath = other
  await $.classic.SessionStart({ source: 'resume', transcript_path: other })
  await clock.settle()
  // From another day: drawn with its date
  expect(await paneCards($)).toEqual([['○ 11/16 14:00 再開した会話']])
})

test('the band stacks its line above the later mods, cut to the terminal\'s width or left out', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('とても長い指示の本文がここに続いていく', 1) })
  await start($, clock, 'terminal')

  expect(await bandLine($, 'desktop')).toEqual({ line: '○ 指示 とても長い指示の本文がここに続いていく · 13:59状況ボード', other: true })
  expect(await bandLine($, 'terminal', 100)).toEqual({ line: '○ 指示 とても長い指示の本文がここに続いていく · 13:59状況ボード', other: true })
  // 44 columns leave 12 cells for the text: five wide characters and the ellipsis
  expect(await bandLine($, 'terminal', 44)).toEqual({ line: '○ 指示 とても長い… · 13:59状況ボード', other: true })
  expect(await bandLine($, 'terminal', 30)).toEqual({ line: undefined, other: true })

  // A step in progress leads with its status and place in the plan, which the cut never takes
  append(h, FILE, plan(items(['ステップの名前がとても長い', 'in_progress']), 0))
  await completeTurn($, clock)
  expect(await bandLine($, 'terminal', 52)).toEqual({ line: '● 進行中 (1/1) ステップの… · 14:00状況ボード', other: true })
})

test('the pane draws a card per prompt, newest first and five at a time, with its recaps whole, its plan folded, and the step in progress on the newest alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // What came before the first prompt makes a card of its own
  let text = prLink(3, 60)
  for (let i = 1; i <= 6; i++) {
    text += prompt(`依頼 ${i}`, 50 - i * 5) + wrap({ recap: `まとめ ${i}`, blocked: i === 6 }, 49 - i * 5)
    // A step left in progress on an older card
    if (i === 5) text += plan(items(['作業', 'in_progress'], ['確認', 'pending']), 23)
  }
  // A turn a task notice began belongs to the card before it; its recap is shown whole
  const long = 'あ'.repeat(300)
  text += prompt('タスクの通知', 15, { promptSource: 'system', origin: undefined }) + wrap({ recap: long, ask: '進めますか?', blocked: true }, 14)
  stubHost(on, { [FILE]: text })
  await start($, clock)

  const newest = ['○ 13:40 依頼 6', '○ 13:41 まとめ 6', `○ 13:46 ${long}`, '質問: 進めますか?', '● 進行中 (1/2) 作業']
  expect(await paneCards($)).toEqual([
    newest,
    ['○ 13:35 依頼 5', '○ 13:36 まとめ 5', '計画 2 ステップ'],
    ['○ 13:30 依頼 4', '○ 13:31 まとめ 4'],
    ['○ 13:25 依頼 3', '○ 13:26 まとめ 3'],
    ['○ 13:20 依頼 2', '○ 13:21 まとめ 2'],
    'さらに 2 件を表示',
  ])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // On the desktop a card is framed; nothing in it is a Button, whose nested Text the app draws
  // without color, so the only Button is the one that shows more
  expect((await historyOf(ui))[0]).toMatchObject({ type: 'Box', props: { borderStyle: 'round' } })
  expect((await ui.findAll({ type: 'Button' })).map((button) => button.key)).toEqual(['status-board-refresh', 'status-board-copy-history', 'status-board-history', 'status-board-more'])
  await ui.press({ key: 'status-board-more' })
  expect((await historyOf(ui)).slice(5).map(asText)).toEqual([['○ 13:15 依頼 1', '○ 13:16 まとめ 1'], ['最初の指示より前', 'PR #3'], '新しい 5 件だけにする'])
  await ui.press({ key: 'status-board-more' })
  expect(await historyOf(ui)).toHaveLength(6)
  await ui.unmount()

  // The terminal draws the same cards, unframed
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const first = (await historyOf(terminal))[0]
  expect(childrenOf(first ?? '').map(textOf)).toEqual(newest)
  expect(first).not.toMatchObject({ props: { borderStyle: 'round' } })
  await terminal.unmount()

  // The small form shows the newest card's latest recap, three lines at most
  const widget = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } })
  const glance = (await widget.drawn()) as Node
  expect(textOf(glance)).toBe(`○ 13:46 ${long}`)
  expect(glance).toMatchObject({ type: 'Text', props: { maxLines: 3 } })
  expect(await widget.findAll({ type: 'Button' })).toHaveLength(0)
  await widget.unmount()
})

test('the band button and /board open the pane and close it again, and say when it cannot be shown', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('開いて', 1) })
  await start($, clock)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'status-board-toggle' })
  expect(h.panes).toEqual(['status-board'])
  await band.press({ key: 'status-board-toggle' })
  expect(h.panes).toEqual([])
  await band.unmount()

  expect(await $.command.run(COMMAND)).toMatchObject({ text: '状況ボードを開きました。' })
  expect(await $.command.run(COMMAND)).toMatchObject({ text: '状況ボードを閉じました。' })

  h.placed = false
  await $.command.run(COMMAND)
  expect(h.toasts).toEqual(['状況ボードを表示できません: no-surface'])
})

// ---------------------------------------------------------------- the board

test('asks for a board when an answer ends with the pane open, shows it with what it cost, and keeps it in the store', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('直して', 10) })
  await start($, clock)

  // Nobody looks while the pane is closed
  await completeTurn($, clock)
  expect(h.forks).toHaveLength(0)

  // Opened on a cache that has likely lapsed, it waits for the button
  await clock.advance(6 * MINUTE)
  await openPane($, clock)
  expect(h.forks).toHaveLength(0)
  expect(await boardOf($)).toEqual({ markdown: undefined, meta: undefined, button: '状況ボードを作る（キャッシュ切れの可能性あり）', error: undefined })

  await completeTurn($, clock)
  expect(h.forks).toEqual([expect.stringContaining('「状況ボード」にまとめてください')])
  expect(await boardOf($)).toEqual({
    markdown: '## 目的\n- 帯を直す',
    meta: '14:06 時点 · モデルによる要約 · 読み 323k / 出力 490',
    button: '状況ボードを更新する',
    error: undefined,
  })
  expect(h.store.get('board:s1')).toEqual({ at: NOW + 6 * MINUTE, text: '## 目的\n- 帯を直す', usage: { read: 322_641, output: 490 } })
  // With no rules set, nothing is proofread
  expect(h.completes).toHaveLength(0)
  expect((await boardOf($, 'terminal')).markdown).toBe('## 目的\n- 帯を直す')

  // An interrupted turn asks for nothing
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't', reason: 'aborted' })
  await clock.settle()
  expect(h.forks).toHaveLength(1)
})

for (const c of [
  { name: 'no board on a warm cache asks for one', stored: false, stale: false, warm: true, forks: 1 },
  { name: 'no board on a cold cache waits', stored: false, stale: false, warm: false, forks: 0 },
  { name: 'an outdated board on a warm cache asks again', stored: true, stale: true, warm: true, forks: 1 },
  { name: 'an outdated board on a cold cache stays, marked', stored: true, stale: true, warm: false, forks: 0 },
  { name: 'a current board on a warm cache stays', stored: true, stale: false, warm: true, forks: 0 },
]) {
  test(`opening the pane: ${c.name}`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = stubHost(on, { [FILE]: prompt('直して', 30) })
    // Written before or after the prompt at 13:30
    if (c.stored) h.store.set('board:s1', { at: NOW - (c.stale ? 40 : 20) * MINUTE, text: '前のボード', usage: { read: 1_500, output: 20 } })
    await start($, clock)
    // A turn that runs keeps the cache warm; with none yet it is taken as cold
    if (c.warm) await $.turn.start({ text: '', turnId: 't' })
    await openPane($, clock)

    expect(h.forks).toHaveLength(c.forks)
    if (c.stored && c.forks === 0) expect((await boardOf($)).markdown).toBe('前のボード')
    if (c.stale && !c.warm) expect((await boardOf($)).meta).toBe('13:20 時点 · モデルによる要約 · その後に動きあり · 読み 2k / 出力 20')
  })
}

test('the button asks once at a time, a failure keeps the board there was, and no conversation yet is no failure', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('直して', 10) })
  h.store.set('board:s1', { at: NOW - 5 * MINUTE, text: '前のボード', usage: { read: 1_500, output: 20 } })
  await start($, clock)
  await openPane($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let release = () => {}
  h.hold = new Promise<void>((resolve) => (release = resolve))
  await ui.press({ key: 'status-board-refresh' })
  await clock.settle()
  expect((await ui.find({ key: 'status-board-refresh' }))?.text).toBe('要約しています…')
  await ui.press({ key: 'status-board-refresh' })
  expect(h.forks).toHaveLength(1)

  h.reply = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' } as unknown as ModelForkResult
  release()
  h.hold = undefined
  await clock.settle()
  await ui.unmount()
  expect(await boardOf($)).toEqual({
    markdown: '前のボード',
    meta: '13:55 時点 · モデルによる要約 · 読み 2k / 出力 20',
    button: '状況ボードを更新する（キャッシュ切れの可能性あり）',
    error: '要約できませんでした: api-error 529',
  })

  h.reply = { isAnswered: false, reason: 'nothing-to-fork' }
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await again.press({ key: 'status-board-refresh' })
  await clock.settle()
  await again.unmount()
  expect(await boardOf($, 'terminal')).toMatchObject({ markdown: '前のボード', error: undefined })
})

test('the history of cards is folded under the board until asked for', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubHost(on, { [FILE]: prompt('直して', 10) })
  await start($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'status-board-history' }))?.text).toBe('履歴を表示')
  expect(await ui.find({ type: 'Text', text: '○ 13:50 直して' })).toBeUndefined()
  await ui.press({ key: 'status-board-history' })
  expect((await ui.find({ key: 'status-board-history' }))?.text).toBe('履歴を隠す')
  expect(await ui.find({ type: 'Text', text: '○ 13:50 直して' })).toBeDefined()
  await ui.press({ key: 'status-board-history' })
  expect(await ui.find({ type: 'Text', text: '○ 13:50 直して' })).toBeUndefined()
  await ui.unmount()
})

test('a board asked for before a switch of conversation is dropped, and a branch starts with none', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const other = '/home/me/.claude/projects/work/s0.jsonl'
  const h = stubHost(on, { [FILE]: prompt('今の会話', 5), [other]: prompt('再開した会話', 60) })
  h.store.set('board:s0', { at: NOW - 30 * MINUTE, text: '再開した会話のボード' })
  await start($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let release = () => {}
  h.hold = new Promise<void>((resolve) => (release = resolve))
  await ui.press({ key: 'status-board-refresh' })
  await ui.unmount()

  h.sessionId = 's0'
  h.transcriptPath = other
  await $.classic.SessionStart({ source: 'resume', transcript_path: other, session_id: 's0' })
  release()
  h.hold = undefined
  await clock.settle()
  expect((await boardOf($)).markdown).toBe('再開した会話のボード')
  expect(h.store.has('board:s1')).toBe(false)

  h.sessionId = 's2'
  await $.classic.SessionStart({ source: 'fork', transcript_path: other, session_id: 's2' })
  await clock.settle()
  expect((await boardOf($)).markdown).toBeUndefined()
})

test('session.start deletes the boards nobody wrote for eight days', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  h.store.set('board:old', { at: NOW - 9 * 24 * 60 * MINUTE, text: '古い' })
  h.store.set('board:recent', { at: NOW - 24 * 60 * MINUTE, text: '新しい' })
  h.store.set('board:broken', 'not a board')
  h.store.set('other', 1)
  await start($, clock)
  expect([...h.store.keys()].sort()).toEqual(['board:recent', 'other'])
})

test('an answer that ends while a board is asked for is summed up again once that board is in; a second press is not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('直して', 10) })
  await start($, clock)
  await openPane($, clock)

  let release = () => {}
  h.hold = new Promise<void>((resolve) => (release = resolve))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'status-board-refresh' })
  await ui.press({ key: 'status-board-refresh' })
  await ui.unmount()
  await completeTurn($, clock)
  expect(h.forks).toHaveLength(1)

  release()
  h.hold = undefined
  await clock.settle()
  expect(h.forks).toHaveLength(2)
})

test('a board written before a turn ended is outdated though no event came after it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('直して', 30) })
  h.store.set('board:s1', { at: NOW - 20 * MINUTE, text: '前のボード' })
  await start($, clock)
  expect((await boardOf($)).meta).toBe('13:40 時点 · モデルによる要約')

  await completeTurn($, clock)
  expect((await boardOf($)).meta).toBe('13:40 時点 · モデルによる要約 · その後に動きあり')
  // Reopened while warm, it is asked for again
  await openPane($, clock)
  expect(h.forks).toHaveLength(1)
})

test('a pane that could not be placed, or is not shown, asks the model for nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('直して', 10) })
  h.placed = false
  await start($, clock)
  await $.turn.start({ text: '', turnId: 't' })
  await openPane($, clock)
  expect(h.toasts).toEqual(['状況ボードを表示できません: no-surface'])
  await completeTurn($, clock)
  expect(h.forks).toHaveLength(0)
})

test('with no events the board can still be made, and the history says there is nothing yet', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  await start($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'status-board-refresh' }))?.text).toBe('状況ボードを作る（キャッシュ切れの可能性あり）')
  await ui.press({ key: 'status-board-refresh' })
  await clock.settle()
  expect(h.forks).toHaveLength(1)
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('## 目的\n- 帯を直す')
  await ui.unmount()
  expect(await paneCards($, 'terminal')).toEqual(['まだ記録はありません。指示や計画がここに並びます。'])
})

test('a transcript that cannot be looked up counts toward the status line, unless it is not there yet', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  await start($, clock)
  await completeTurn($, clock)
  await completeTurn($, clock)
  // Missing: never a failure
  expect(h.status).toBeUndefined()

  h.files.set(FILE, utf8(prompt('読める', 1)))
  h.failStats = 3
  await completeTurn($, clock)
  await completeTurn($, clock)
  expect(h.status).toBeUndefined()
  await completeTurn($, clock)
  expect(h.status).toBe('status-board: 会話ログを読めません: status-board: $.fs.stat: EACCES: permission denied')
  await completeTurn($, clock)
  expect(h.status).toBeUndefined()
})

// ---------------------------------------------------------------- the display language

const ENGLISH = { language: undefined }

test('with no language configured, the band and the cards are in English, with plurals by count', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(
    on,
    {
      [FILE]:
        prompt('Fix the band', 40) +
        plan(items(['Look', 'in_progress'], ['Change', 'pending'], ['Check', 'pending']), 39) +
        plan({ done: [1, 2] }, 38) +
        prLink(12, 37),
    },
    ENGLISH,
  )
  await start($, clock)
  expect((await bandLine($)).line).toBe('○ Linked PR #12 · 13:23Status board')

  append(h, FILE, prompt('Read it', 30))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('○ Prompt Read it · 13:30Status board')

  append(h, FILE, toolUse('AskUserQuestion', { questions: [{ question: 'Which one?' }, { question: 'Then?' }] }, 25, 'toolu_ask'))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('● Question Which one? (+1 more) · 13:35Status board')

  append(h, FILE, wrap({ recap: 'Done reading', ask: 'Fix it?', blocked: true }, 22))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('○ Recap Done reading / Question: Fix it? · 13:38Status board')

  append(h, FILE, plan(items(['Read', 'in_progress']), 19))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('● In progress (1/1) Read · 13:41Status board')
  expect(await paneCards($)).toEqual([
    ['○ 13:30 Read it', '● 13:35 Question Which one? (+1 more)', '○ 13:38 Done reading', 'Question: Fix it?', '● In progress (1/1) Read', 'Plan: 1 step'],
    ['○ 13:20 Fix the band', 'Plan: 3 steps · 2 done · PR #12'],
  ])

  // A plan after a finished one is created, one after an unfinished one updated
  append(h, FILE, wrap({ recap: 'Finished' }, 18) + plan(items(['Next', 'pending']), 17))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('● Plan created: 1 step · 13:43Status board')
  append(h, FILE, plan(items(['Next', 'pending'], ['Polish', 'pending']), 16))
  await completeTurn($, clock)
  expect((await bandLine($)).line).toBe('● Plan updated: 2 steps · 13:44Status board')
})

test('with no language configured, /board, the pane, its board, buttons and failures are in English, and the model is asked in English', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, {}, ENGLISH)
  await start($, clock)
  expect(h.commands).toEqual(["Open or close this session's status board"])
  expect(await $.command.run(COMMAND)).toMatchObject({ text: 'Opened the status board.' })
  expect(h.titles).toEqual(['Status board'])
  expect(await $.command.run(COMMAND)).toMatchObject({ text: 'Closed the status board.' })

  expect(await paneCards($)).toEqual(['No record yet. Prompts and plans will be listed here.'])
  const widget = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } })
  expect(textOf((await widget.drawn()) as Node)).toBe('No record yet.')
  await widget.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'status-board-refresh' }))?.text).toBe('Create the status board (cache may be cold)')
  let release = () => {}
  h.hold = new Promise<void>((resolve) => (release = resolve))
  await ui.press({ key: 'status-board-refresh' })
  await clock.settle()
  expect((await ui.find({ key: 'status-board-refresh' }))?.text).toBe('Summarizing…')
  release()
  h.hold = undefined
  await clock.settle()
  // Shown since the history was read above
  expect((await ui.find({ key: 'status-board-history' }))?.text).toBe('Hide history')
  await ui.press({ key: 'status-board-history' })
  expect((await ui.find({ key: 'status-board-history' }))?.text).toBe('Show history')
  await ui.unmount()

  // The board's language is the prompt's: five English headings
  for (const heading of ['## Goal', '## Where things stand', '## Decided', '## Open / waiting on you', '## Next step']) {
    expect(h.forks[0]).toContain(`\n${heading}\n`)
  }
  expect(h.forks[0]).toContain('English Markdown')
  expect(await boardOf($)).toMatchObject({
    meta: 'As of 14:00 · summarized by the model · read 323k / output 490',
    button: 'Update the status board (cache may be cold)',
  })

  // A turn that ends after the board outdates it, and warms the cache
  await clock.advance(MINUTE)
  await completeTurn($, clock)
  h.reply = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' } as unknown as ModelForkResult
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await again.press({ key: 'status-board-refresh' })
  await clock.settle()
  await again.unmount()
  expect(await boardOf($)).toMatchObject({
    meta: 'As of 14:00 · summarized by the model · activity since · read 323k / output 490',
    button: 'Update the status board',
    error: 'Could not summarize: api-error 529',
  })

  h.placed = false
  await $.command.run(COMMAND)
  expect(h.toasts).toEqual(['Cannot show the status board: no-surface'])
})

test('with no language configured, the history pages in English and names the card before the first prompt', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let text = prLink(3, 60)
  for (let i = 1; i <= 6; i++) text += prompt(`Task ${i}`, 50 - i * 5)
  stubHost(on, { [FILE]: text }, ENGLISH)
  await start($, clock)

  expect((await paneCards($)).at(-1)).toBe('Show 2 more')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await historyOf(ui)
  await ui.press({ key: 'status-board-more' })
  expect((await historyOf(ui)).slice(5).map(asText)).toEqual([['○ 13:15 Task 1'], ['Before the first prompt', 'PR #3'], 'Show only the newest 5'])
  await ui.unmount()
})

test('with no language configured, a transcript that cannot be read says so in English in the status line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('Readable', 1) }, ENGLISH)
  h.failReads = 3
  await start($, clock)
  await completeTurn($, clock)
  await completeTurn($, clock)
  expect(h.status).toBe('status-board: cannot read the transcript: status-board: $.fs.read: EACCES: permission denied')
})

const JAPANESE_DESCRIPTION = 'このセッションの状況ボードを開閉する'
const ENGLISH_DESCRIPTION = "Open or close this session's status board"

type LocaleCase = { name: string; language?: string; env?: Record<string, string>; settingsFail?: boolean; japanese: boolean }

for (const c of <LocaleCase[]>[
  { name: 'the setting `japanese` gives Japanese', language: 'japanese', japanese: true },
  { name: 'the setting `Japanese` gives Japanese', language: 'Japanese', japanese: true },
  { name: 'the setting `ja` gives Japanese', language: 'ja', japanese: true },
  { name: 'the setting `ja-JP` gives Japanese', language: 'ja-JP', japanese: true },
  { name: 'the setting `日本語` gives Japanese', language: '日本語', japanese: true },
  { name: 'the setting `english` gives English even under LANG=ja_JP.UTF-8', language: 'english', env: { LANG: 'ja_JP.UTF-8' }, japanese: false },
  { name: 'no setting under LANG=ja_JP.UTF-8 gives Japanese', env: { LANG: 'ja_JP.UTF-8' }, japanese: true },
  { name: 'no setting and no locale variables gives English', japanese: false },
  { name: 'LC_ALL wins over LC_MESSAGES and LANG', env: { LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'ja_JP.UTF-8', LANG: 'ja_JP.UTF-8' }, japanese: false },
  { name: 'LC_MESSAGES wins over LANG', env: { LC_MESSAGES: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' }, japanese: true },
  { name: 'settings that cannot be read give English even under LANG=ja_JP.UTF-8', env: { LANG: 'ja_JP.UTF-8' }, settingsFail: true, japanese: false },
]) {
  test(`display language: ${c.name}`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = stubHost(on, {}, { language: c.language, env: c.env ?? {}, settingsFail: c.settingsFail ?? false })
    await start($, clock)
    expect(h.commands).toEqual([c.japanese ? JAPANESE_DESCRIPTION : ENGLISH_DESCRIPTION])
  })
}

test('a re-fired session.start draws in the language the setting names by then', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('Fix it', 10) })
  await start($, clock)
  expect((await bandLine($)).line).toBe('○ 指示 Fix it · 13:50状況ボード')

  h.language = 'english'
  await start($, clock)
  expect((await bandLine($)).line).toBe('○ Prompt Fix it · 13:50Status board')
  expect(h.commands).toEqual([JAPANESE_DESCRIPTION, ENGLISH_DESCRIPTION])
})

test('a turn that ends while a re-fired session.start resolves the language reads nothing in the language before', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('Fix it', 10) + plan(items(['Next', 'pending']), 9) }, ENGLISH)
  await start($, clock)
  expect((await bandLine($)).line).toBe('● Plan created: 1 step · 13:51Status board')

  h.language = 'japanese'
  let release = () => {}
  h.settingsHold = new Promise<void>((resolve) => (release = resolve))
  const restarted = $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await completeTurn($, clock)
  release()
  h.settingsHold = undefined
  await restarted
  await clock.settle()
  expect((await bandLine($)).line).toBe('● 計画を作成: 1 ステップ · 13:51状況ボード')
})

// ---------------------------------------------------------------- the time zone

const SUMMER = Date.UTC(2026, 6, 1, 5)

for (const c of [
  // 05:00 UTC on 18 November is midnight in New York (UTC-5): ten minutes earlier is the 17th there
  { name: 'in winter, with the date when the time is yesterday there', now: NOW, cards: [['○ 00:00 now'], ['○ 11/17 23:50 earlier']] },
  // On 1 July New York keeps daylight saving time (UTC-4)
  { name: 'in summer, under daylight saving time', now: SUMMER, cards: [['○ 01:00 now'], ['○ 00:50 earlier']] },
]) {
  test(`TZ=America/New_York draws times at New York's local time ${c.name}`, async ($, on) => {
    const clock = mock.clock(on, { now: c.now })
    const at = (minutesAgo: number) => new Date(c.now - minutesAgo * MINUTE).toISOString()
    stubHost(on, { [FILE]: prompt('earlier', 0, { timestamp: at(10) }) + prompt('now', 0, { timestamp: at(0) }) }, { env: { TZ: 'America/New_York' } })
    await start($, clock)
    expect(await paneCards($)).toEqual(c.cards)
  })
}

test('a TZ Intl does not know draws times in the runtime\'s zone instead of failing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubHost(on, { [FILE]: prompt('Fix it', 10) }, { env: { TZ: 'JST-9' } })
  await start($, clock)
  const cards = await paneCards($)
  expect(cards).toHaveLength(1)
  // The runtime's zone is the machine's, so only the shape is known
  expect((cards[0] as string[])[0]).toMatch(/^○ (\d{1,2}\/\d{1,2} )?\d{2}:\d{2} Fix it$/)
})

test('a re-fired session.start draws times in the zone TZ names by then', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('Fix it', 10) })
  await start($, clock)
  expect(await paneCards($)).toEqual([['○ 13:50 Fix it']])

  h.env.TZ = 'America/New_York'
  await start($, clock)
  expect(await paneCards($)).toEqual([['○ 11/17 23:50 Fix it']])
})

test('the copy buttons put the board and the history on the clipboard of the pressing surface', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, {
    [FILE]:
      prompt('ログを調べて', 30) +
      toolUse('mcp__ccd_turn__wrap_up', { recap: '原因はキャッシュ', ask: '直しますか？' }, 25, 'w1') +
      prompt('直して', 10) +
      toolUse('AskUserQuestion', { questions: [{ question: 'どちらで？' }] }, 9, 'q1'),
  })
  h.store.set('board:s1', { at: NOW - MINUTE, text: '## 目的\n- 帯を直す', usage: { read: 1_500, output: 20 } })
  const copies: { text: string; surface: string | undefined }[] = []
  let answer: { isCopied: true } | { isCopied: false; reason: 'no-clipboard' } = { isCopied: true }
  on('ui.copy', ($, e) => {
    copies.push({ text: e.text, surface: e.surface })
    return { value: answer }
  })
  await start($, clock)
  await openPane($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'status-board-copy' })
  await clock.settle()
  await ui.press({ key: 'status-board-copy-history' })
  await clock.settle()
  answer = { isCopied: false, reason: 'no-clipboard' }
  await ui.press({ key: 'status-board-copy' })
  await clock.settle()
  await ui.unmount()

  expect(copies).toEqual([
    { text: '## 目的\n- 帯を直す', surface: 'desktop' },
    {
      text: '[13:50] 指示: 直して\n[13:51] 質問: どちらで？\n\n[13:30] 指示: ログを調べて\n[13:35] まとめ: 原因はキャッシュ\n質問: 直しますか？',
      surface: 'desktop',
    },
    { text: '## 目的\n- 帯を直す', surface: 'desktop' },
  ])
  expect(h.toasts).toEqual(['状況ボードをコピーしました。', '履歴をコピーしました。', 'コピーできませんでした: no-clipboard'])
})

test('no copy button is drawn with nothing to copy, and the English labels and toasts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, {}, { language: undefined })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  await start($, clock)
  await openPane($, clock)
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button' })).map((button) => button.key)).toEqual(['status-board-refresh', 'status-board-history'])
  await ui.unmount()

  h.store.set('board:s1', { at: NOW - MINUTE, text: '## Goal\n- fix the band', usage: { read: 1_500, output: 20 } })
  append(h, FILE, prompt('fix it', 10))
  await start($, clock)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'status-board-copy' }))?.text).toBe('Copy the board')
  expect((await ui.find({ key: 'status-board-copy-history' }))?.text).toBe('Copy the history')
  await ui.press({ key: 'status-board-copy' })
  await ui.press({ key: 'status-board-copy-history' })
  await clock.settle()
  await ui.unmount()
  expect(h.toasts).toEqual(['Copied the status board.', 'Copied the history.'])
})

// ---------------------------------------------------------------- proofreading

const HOME = '/home/me'
const RULES = `${HOME}/rules.md`
const RULES_TEXT = '# 規範\n- 漢語を和語に開く'
const DRAFT = '## 目的\n- 帯を直す\n## 未解決・あなたの判断待ち\n- なし\n## 現在地\n- 帯の幅を測った（テスト実行で確認）\n## 決まったこと\n- 幅は 80 桁に揃える\n## 次の一手\n- モデルが帯を直す'
const PROOFREAD = '## 目的\n- 帯を直します\n## 未解決・あなたの判断待ち\n- なし\n## 現在地\n- 帯の幅を測りました（テスト実行で確認）\n## 決まったこと\n- 幅は 80 桁にそろえる\n## 次の一手\n- モデルが帯を直します'

// A proofread's answer: what the proofreading model wrote, with usage of its own
function proofread(text: string): ModelCompleteResult {
  return { isAnswered: true, text, usage: { input_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 5_000, output_tokens: 300 } } as ModelCompleteResult
}

// A host whose summary answers DRAFT, with the rules file at RULES, and the pane open on a warm cache
async function proofHost($: Engine, on: On, files: Record<string, string> = { [RULES]: RULES_TEXT }) {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('直して', 10), ...files }, { env: { HOME } })
  h.reply = answered(DRAFT)
  h.proofReply = proofread(PROOFREAD)
  await start($, clock)
  await openPane($, clock)
  return { clock, h }
}

test('with rules set, the summary shows at once, is proofread against them, and the pane switches between the two', { options: { proofreadRules: '~/rules.md', proofreadModel: 'haiku' } }, async ($, on) => {
  const copies: string[] = []
  on('ui.copy', ($, e) => {
    copies.push(e.text)
    return { value: { isCopied: true } }
  })
  const { clock, h } = await proofHost($, on)
  let release = () => {}
  h.proofHold = new Promise<void>((resolve) => (release = resolve))
  await completeTurn($, clock)

  // The summary does not wait on the proofread
  expect(await boardOf($)).toMatchObject({ markdown: DRAFT, button: '校正しています…', proofError: undefined })
  expect(h.completes).toEqual([
    {
      model: 'haiku',
      // The fixed frame and the rules lead and are cached; the board follows, unmarked
      prompt: [
        { text: expect.stringContaining('校正後の Markdown だけを返してください') },
        { text: `${RULES_TEXT}\n</rules>\n`, cache: true },
        { text: `<board>\n${DRAFT}\n</board>` },
      ],
      maxTokens: expect.any(Number),
      timeoutMs: expect.any(Number),
    },
  ])
  // A Japanese board can pass the default cap of 1,024 tokens
  expect(h.completes[0]?.maxTokens).toBeGreaterThan(1_024)

  release()
  await clock.settle()
  expect(await boardOf($)).toEqual({
    markdown: PROOFREAD,
    meta: '14:00 時点 · モデルによる要約 · 校正済み · 読み 329k / 出力 790',
    button: '状況ボードを更新する',
    error: undefined,
    proofError: undefined,
  })
  // `text` is what an older version shows; the draft rides beside it
  expect(h.store.get('board:s1')).toEqual({ at: NOW, text: PROOFREAD, draft: DRAFT, usage: { read: 328_641, output: 790 } })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'status-board-proofread-toggle' }))?.text).toBe('校正前を表示')
  await ui.press({ key: 'status-board-copy' })
  await ui.press({ key: 'status-board-proofread-toggle' })
  await ui.press({ key: 'status-board-copy' })
  await clock.settle()
  expect((await ui.find({ key: 'status-board-proofread-toggle' }))?.text).toBe('校正後を表示')
  await ui.unmount()
  expect(await boardOf($)).toMatchObject({ markdown: DRAFT, meta: '14:00 時点 · モデルによる要約 · 校正前 · 読み 329k / 出力 790' })
  // Switched back, the proofread board is what is copied again
  const back = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await back.press({ key: 'status-board-proofread-toggle' })
  await back.press({ key: 'status-board-copy' })
  await clock.settle()
  await back.unmount()
  expect(copies).toEqual([PROOFREAD, DRAFT, PROOFREAD])
  expect(h.toasts).toEqual(['校正後のボードをコピーしました。', '校正前のボードをコピーしました。', '校正後のボードをコピーしました。'])

  // A board read back from the store keeps both
  await start($, clock)
  expect(await boardOf($)).toMatchObject({ markdown: PROOFREAD, meta: expect.stringContaining('校正済み') })
})

const proofCases: { name: string; files: Record<string, string>; reply: ModelCompleteResult | 'refused'; error: unknown }[] = [
  { name: 'a reply whose headings changed', files: { [RULES]: RULES_TEXT }, reply: proofread(PROOFREAD.replace('## 現在地', '## 今の状況')), error: '校正できませんでした: 見出しが変わったので、校正前のボードを表示しています' },
  { name: 'a reply that merged two items', files: { [RULES]: RULES_TEXT }, reply: proofread(PROOFREAD.replace('\n## 決まったこと\n- 幅は 80 桁にそろえる', '、幅は 80 桁にそろえる\n## 決まったこと')), error: '校正できませんでした: 項目の数が変わったので、校正前のボードを表示しています' },
  { name: 'a rules file that is not there', files: {}, reply: proofread(PROOFREAD), error: expect.stringMatching(/^校正できませんでした: .*ENOENT/) },
  { name: 'a rules file over 200 KB', files: { [RULES]: 'x'.repeat(200 * 1024 + 1) }, reply: proofread(PROOFREAD), error: '校正できませんでした: 規範のファイルが 200 KB を超えています' },
  { name: 'a model that does not answer', files: { [RULES]: RULES_TEXT }, reply: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' } as unknown as ModelCompleteResult, error: '校正できませんでした: api-error 529' },
  // A model the engine refuses (a typo in the setting) rejects the call rather than resolving
  { name: 'a model the engine refuses', files: { [RULES]: RULES_TEXT }, reply: 'refused', error: expect.stringMatching(/^校正できませんでした: .*unknown model/) },
]
for (const c of proofCases) {
  test(`proofreading: ${c.name} leaves the summary's board and says why`, { options: { proofreadRules: '~/rules.md' } }, async ($, on) => {
    const { clock, h } = await proofHost($, on, c.files)
    if (c.reply === 'refused') h.proofDeny = 'unknown model: sonet'
    else h.proofReply = c.reply
    await completeTurn($, clock)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'status-board-proofread-toggle' })).toBeUndefined()
    await ui.unmount()
    expect(await boardOf($)).toMatchObject({ markdown: DRAFT, button: '状況ボードを更新する', error: undefined, proofError: c.error })
    expect((h.store.get('board:s1') as { text: string; draft?: string }).text).toBe(DRAFT)
    expect(h.store.get('board:s1')).not.toHaveProperty('draft')
  })
}

test('a * segment of the rules path takes the highest version there, and a folder its SKILL.md', { options: { proofreadRules: '~/.claude/plugins/cache/m/p/*/skills/style' } }, async ($, on) => {
  const base = `${HOME}/.claude/plugins/cache/m/p`
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('fix it', 10), [`${base}/3.10.0/skills/style/SKILL.md`]: 'newest rules', [`${base}/3.9.0/skills/style/SKILL.md`]: 'older rules' }, { language: undefined, env: { HOME } })
  h.dirs.set(base, [
    { name: '3.9.0', kind: 'dir' },
    { name: '3.10.0', kind: 'other', isLink: true },
    { name: '3.2.2', kind: 'dir' },
    { name: '9.0.0.zip', kind: 'file' },
    { name: 'unknown', kind: 'dir' },
  ])
  h.dirs.set(`${base}/3.10.0/skills/style`, [])
  on('ui.copy', () => ({ value: { isCopied: true } }))
  const draft = '## Goal\n- fix the band\n## Next step\n- the model fixes it'
  h.reply = answered(draft)
  h.proofReply = proofread('## Goal\n- Fix the band.\n## Next step\n- The model fixes it.')
  await start($, clock)
  await openPane($, clock)
  await completeTurn($, clock)

  expect(h.completes[0]?.prompt).toEqual([{ text: expect.stringContaining('Return only the proofread Markdown') }, { text: 'newest rules\n</rules>\n', cache: true }, { text: `<board>\n${draft}\n</board>` }])
  expect(await boardOf($)).toMatchObject({ markdown: '## Goal\n- Fix the band.\n## Next step\n- The model fixes it.', meta: expect.stringContaining('summarized by the model · proofread ·') })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'status-board-proofread-toggle' }))?.text).toBe('Show before proofreading')
  await ui.press({ key: 'status-board-copy' })
  await ui.press({ key: 'status-board-proofread-toggle' })
  await ui.press({ key: 'status-board-copy' })
  await clock.settle()
  await ui.press({ key: 'status-board-proofread-toggle' })
  await ui.unmount()
  expect(h.toasts).toEqual(['Copied the proofread board.', 'Copied the board before proofreading.'])

  // A * with nothing under it
  h.dirs.set(base, [])
  await completeTurn($, clock)
  expect(await boardOf($)).toMatchObject({ markdown: draft, proofError: 'Could not proofread: no folder matches the * in the rules path' })
})

test('a proofread overtaken by a switch of conversation is dropped, and an answer ending during it asks again', { options: { proofreadRules: '~/rules.md' } }, async ($, on) => {
  const { clock, h } = await proofHost($, on)
  let release = () => {}
  h.proofHold = new Promise<void>((resolve) => (release = resolve))
  await completeTurn($, clock)
  // Pressed during the proofread, the button does nothing; an answer that ends asks again after
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'status-board-refresh' })
  await ui.unmount()
  await completeTurn($, clock)
  expect(h.forks).toHaveLength(1)
  release()
  await clock.settle()
  expect(h.forks).toHaveLength(2)
  expect(h.completes).toHaveLength(2)

  const kept = h.store.get('board:s1')
  h.proofHold = new Promise<void>((resolve) => (release = resolve))
  h.proofReply = proofread(PROOFREAD.replace('モデルが帯を直します', 'モデルが帯を直す予定です'))
  await completeTurn($, clock)
  // The conversation resumed has a board of its own, which the answer must not land on
  h.store.set('board:s9', { at: NOW - 30 * MINUTE, text: '再開した会話のボード' })
  await $.classic.SessionStart({ source: 'resume', transcript_path: FILE, session_id: 's9' })
  await clock.settle()
  release()
  await clock.settle()
  expect(h.store.get('board:s1')).toEqual(kept)
  expect(h.store.get('board:s9')).toEqual({ at: NOW - 30 * MINUTE, text: '再開した会話のボード' })
  expect((await boardOf($)).markdown).toBe('再開した会話のボード')
})

// ---------------------------------------------------------------- pull request links on the board

const PR12 = '[#12](https://github.com/o/r/pull/12)'
const PR3 = '[#3](https://github.com/o/r/pull/3)'

test('the board links the pull request numbers the conversation linked, skipping code, links, URLs, words and ambiguous or unknown numbers', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, {
    [FILE]:
      prompt('直して', 30) +
      prLink(12, 25) +
      prLink(3, 24) +
      // Two repositories' pull requests numbered 7: neither is linked
      prLink(7, 23) +
      prLink(7, 22, 'o/other') +
      // A URL that is not https is drawn as text by the Markdown element
      prLink(9, 21, 'o/r', 'http'),
  })
  const board = [
    '## 目的',
    '- 検索結果の順序を直す PR（#12）。もう一度 #12 と書く。',
    '- 前の PR (#3), 別リポジトリの #7, 知らない #5, 平文の #9, 桁違いの #123 と #120',
    '- コード `#12` と ``a ` #12``、リンク [#12](https://example.com/12) と [詳細](https://github.com/o/r/pull/12#issuecomment-1)',
    '- URL https://github.com/o/r/issues/12#issuecomment-3（#3）と <https://github.com/o/r/pull/3>',
    '- 語の一部 abc#12, x/12#3, &#12;, \\#12, #12a, #012',
    '```',
    '#12',
    '```',
    '  ~~~text',
    '  #3',
    '  ~~~',
    '# 12 は見出しの記号ではない',
  ].join('\n')
  h.store.set('board:s1', { at: NOW - MINUTE, text: board })
  const copies: string[] = []
  on('ui.copy', ($, e) => {
    copies.push(e.text)
    return { value: { isCopied: true } }
  })
  await start($, clock)
  await openPane($, clock)

  const linked = [
    '## 目的',
    `- 検索結果の順序を直す PR（${PR12}）。もう一度 ${PR12} と書く。`,
    `- 前の PR (${PR3}), 別リポジトリの #7, 知らない #5, 平文の #9, 桁違いの #123 と #120`,
    '- コード `#12` と ``a ` #12``、リンク [#12](https://example.com/12) と [詳細](https://github.com/o/r/pull/12#issuecomment-1)',
    `- URL https://github.com/o/r/issues/12#issuecomment-3（${PR3}）と <https://github.com/o/r/pull/3>`,
    '- 語の一部 abc#12, x/12#3, &#12;, \\#12, #12a, #012',
    '```',
    '#12',
    '```',
    '  ~~~text',
    '  #3',
    '  ~~~',
    '# 12 は見出しの記号ではない',
  ].join('\n')
  expect((await boardOf($)).markdown).toBe(linked)

  // The copy carries the links; the stored board stays as the model wrote it
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'status-board-copy' })
  await clock.settle()
  await ui.unmount()
  expect(copies).toEqual([linked])
  expect(h.store.get('board:s1')).toEqual({ at: NOW - MINUTE, text: board })
  expect(h.forks).toEqual([])
})

test('a pull request linked after the board was written is linked on the board at the next read, with no new summary', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('直して', 30) })
  h.store.set('board:s1', { at: NOW - MINUTE, text: '## 目的\n- 順序を直す PR（#12）' })
  await start($, clock)
  await openPane($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('## 目的\n- 順序を直す PR（#12）')

  append(h, FILE, prLink(12, 0))
  await clock.advance(30_000)
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe(`## 目的\n- 順序を直す PR（${PR12}）`)
  await ui.unmount()
  expect(h.forks).toEqual([])
})

test('the proofread board and the draft are both linked, and a board the links would push past the Markdown limit is drawn unlinked', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { [FILE]: prompt('直して', 30) + prLink(12, 25) })
  h.store.set('board:s1', { at: NOW - MINUTE, text: '## 目的\n- 校正後（#12）', draft: '## 目的\n- 校正前（#12）' })
  const copies: string[] = []
  on('ui.copy', ($, e) => {
    copies.push(e.text)
    return { value: { isCopied: true } }
  })
  await start($, clock)
  await openPane($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe(`## 目的\n- 校正後（${PR12}）`)
  await ui.press({ key: 'status-board-copy' })
  await clock.settle()
  await ui.press({ key: 'status-board-proofread-toggle' })
  await clock.settle()
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe(`## 目的\n- 校正前（${PR12}）`)
  await ui.press({ key: 'status-board-copy' })
  await clock.settle()
  await ui.unmount()
  expect(copies).toEqual([`## 目的\n- 校正後（${PR12}）`, `## 目的\n- 校正前（${PR12}）`])

  // 9,990 characters fit; with the link they would not
  const long = '## 目的\n- #12 ' + 'あ'.repeat(9_990 - '## 目的\n- #12 '.length)
  h.store.set('board:s2', { at: NOW - MINUTE, text: long })
  h.sessionId = 's2'
  await start($, clock)
  expect((await boardOf($)).markdown).toBe(long)
})

test('a board summarized and proofread while a pull request is linked is drawn linked but stored and proofread unlinked', { options: { proofreadRules: '~/rules.md' } }, async ($, on) => {
  const { clock, h } = await proofHost($, on, { [RULES]: RULES_TEXT, [FILE]: prompt('直して', 10) + prLink(12, 9) })
  h.reply = answered('## 目的\n- 順序を直す（#12）')
  h.proofReply = proofread('## 目的\n- 順序を直す PR（#12）')
  await completeTurn($, clock)

  expect((await boardOf($)).markdown).toBe(`## 目的\n- 順序を直す PR（${PR12}）`)
  expect(h.completes[0]?.prompt).toContainEqual({ text: '<board>\n## 目的\n- 順序を直す（#12）\n</board>' })
  expect(h.store.get('board:s1')).toMatchObject({ text: '## 目的\n- 順序を直す PR（#12）', draft: '## 目的\n- 順序を直す（#12）' })
})
