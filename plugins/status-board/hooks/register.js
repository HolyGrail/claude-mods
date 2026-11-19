// Shows this session's status board in a pane: the model's summary of the whole session (its aim,
// where it stands, what was decided, what waits on the person, what comes next), asked of a fork
// of the conversation, with the record it rests on folded under it as a history of cards, one per
// prompt. One line above the prompt says where the session stands.
//
// The record is this session's timeline: the prompts a person typed, the plans and steps of
// mcp__ccd_turn__update_plan, the recaps of mcp__ccd_turn__wrap_up, AskUserQuestion dialogs and
// the pull requests the desktop app linked.
//
// Everything comes from the session's JSONL transcript, read from where the last read stopped:
// a plan's steps are the replay of every update_plan input applied to the plan before it, which
// no hook can rebuild after /resume or when the mod is enabled mid-session, and the timestamps,
// the prompt's source and the pr-link rows are only in the file. The derivation is ported from
// agent-dashboard's lib/collect.mjs.

const TOOL_PLAN = 'mcp__ccd_turn__update_plan'
const TOOL_WRAP = 'mcp__ccd_turn__wrap_up'
const TOOL_DIALOG = 'AskUserQuestion'
const STATUSES = new Set(['pending', 'in_progress', 'completed'])

// An event's text is cut here, with an ellipsis; the timeline keeps this many events
const TEXT_LIMIT = 200
// A recap and its question are read whole in the pane (wrap_up keeps a recap to some 300
// characters and a question to some 100)
const RECAP_LIMIT = 1_000
const KEEP = 300
// $.fs.read returns at most 4 MiB a call
const CHUNK = 4 * 1024 * 1024
// A line longer than this (a pasted image, a large tool result) is dropped rather than held
const CARRY_LIMIT = 64 * 1024 * 1024
// The engine writes a turn's prompt row a few tens of milliseconds after turn.start (measured on
// 2.1.327), so the read that picks it up waits this long
const START_DELAY_MS = 250
// While a turn runs, the plan moves with each update_plan call; idle, only a pr-link row or
// another process may add to the file
const TURN_TICK_MS = 2_000
const IDLE_TICK_MS = 30_000
// After this many failed reads in a row, the status line says so
const FAILURES_SHOWN = 3

// The board the model writes: the whole session summed up, the pane's lead, one fixed prompt per
// locale. Asked with no `effort`, since a level other than the session's makes a model that takes
// effort for the whole request write the conversation to the cache again; the prompt asks for
// haste instead. English runs about twice as long as Japanese for the same content, hence the
// larger cap.
const BOARD_PROMPT_EN = `Sum up this conversation so far as a "status board" that lets the person watching this session grasp the whole of it in 30 seconds.
You have no tools now. Do not deliberate: write only the answer, at once, with no preamble and no closing remarks.
Use only facts stated in the conversation and write no guesses. Write English Markdown with these headings, in this order.
Keep each item a short bullet (80 characters at most) and the whole board within 1,200 characters. Under a heading with nothing to say, write "None".

## Goal
(What this session sets out to achieve. 1-2 items)
## Where things stand
(What is done, and what is under way now. 3-5 items)
## Decided
(Decisions on approach or design, and why. Up to 5 of the important ones)
## Open / waiting on you
(What the person needs to decide or check. "None" if nothing)
## Next step
(What happens next. 1-2 items)`
const BOARD_PROMPT_JA = `ここまでの会話を、このセッションを見ている人間が 30 秒で全体を把握するための「状況ボード」にまとめてください。
あなたにはいまツールがありません。考え込まず、すぐに答えだけを書いてください。前置きも後書きも不要です。
会話に書かれた事実だけを使い、推測は書かないでください。日本語の Markdown で、次の見出しをこの順に使います。
各項目は短い箇条書き（1 項目 40 字以内）にし、全体で 700 字以内に収めてください。該当がない見出しは「なし」と書きます。

## 目的
（このセッションで達成しようとしていること。1〜2 項目）
## 現在地
（何が終わり、いま何をしているか。3〜5 項目）
## 決まったこと
（方針や設計の決定と、その理由。重要なものを 5 項目まで）
## 未解決・あなたの判断待ち
（人間が決める・確かめる必要があること。なければ「なし」）
## 次の一手
（次に起きること。1〜2 項目）`
// The main conversation's cache is taken as warm while a turn runs and this long after one ends:
// the shorter TTL, so a board is not asked for on a cache that has likely lapsed
const WARM_MS = 5 * 60_000
// Boards not written for this long are deleted at session.start
const STALE_MS = 8 * 24 * 60 * 60_000
const BOARD_PREFIX = 'board:'

const PANE = 'status-board'
// The pane shows the newest cards first, this many until asked for the rest
const SHOWN = 5
// The band's last column, which the terminal may draw over
const BAND_RESERVED_COLUMNS = 2
// Off the terminal, the band's text is cut to this many cells (wide characters count two)
const BAND_TEXT_CELLS = 80
// Times are drawn in the machine's time zone: TZ when Intl knows it, else the runtime's own zone
// (which follows the system's). Two-digit 24-hour times and ASCII digits in either locale
const CLOCK_OPTIONS = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}
// The session.end reasons after which this module stops; /clear, /resume and logout leave it
// running
const FINAL_REASONS = ['prompt_input_exit', 'other']

// Everything a person reads, and the prompt the model gets, per locale. Where the word order
// differs between the languages a text is a function, not fragments joined. Nothing here is
// written to $.store: sessions in either locale, and of older versions, share the stored boards.
const TEXTS = {
  en: {
    paneTitle: 'Status board',
    steps: { completed: 'Done', in_progress: 'In progress', pending: 'Pending' },
    labels: { recap: 'Recap', dialog: 'Question', prompt: 'Prompt' },
    boardPrompt: BOARD_PROMPT_EN,
    commandDescription: "Open or close this session's status board",
    opened: 'Opened the status board.',
    closed: 'Closed the status board.',
    unreadable: (error) => `status-board: cannot read the transcript: ${error}`,
    noQuestion: 'Answer the question',
    moreQuestions: (question, more) => `${question} (+${more} more)`,
    plan: (fresh, count) => `${fresh ? 'Plan created' : 'Plan updated'}: ${stepCount(count)}`,
    recapAsk: (ask) => ` / Question: ${ask}`,
    linked: (pr) => `Linked ${pr}`,
    planSize: (count) => `Plan: ${stepCount(count)}`,
    completedSteps: (count) => `${count} done`,
    noRecord: 'No record yet.',
    noRecordYet: 'No record yet. Prompts and plans will be listed here.',
    beforeFirstPrompt: 'Before the first prompt',
    ask: (ask) => `Question: ${ask}`,
    asOf: (time) => `As of ${time}`,
    byModel: 'summarized by the model',
    stale: 'activity since',
    usage: (read, output) => `read ${read} / output ${output}`,
    summarizing: 'Summarizing…',
    update: 'Update the status board',
    create: 'Create the status board',
    cold: ' (cache may be cold)',
    failed: (reason) => `Could not summarize: ${reason}`,
    showHistory: 'Show history',
    hideHistory: 'Hide history',
    fewer: (shown) => `Show only the newest ${shown}`,
    more: (count) => `Show ${count} more`,
    cannotShow: (reason) => `Cannot show the status board: ${reason}`,
  },
  ja: {
    paneTitle: '状況ボード',
    steps: { completed: '完了', in_progress: '進行中', pending: '未着手' },
    labels: { recap: 'まとめ', dialog: '質問', prompt: '指示' },
    boardPrompt: BOARD_PROMPT_JA,
    commandDescription: 'このセッションの状況ボードを開閉する',
    opened: '状況ボードを開きました。',
    closed: '状況ボードを閉じました。',
    unreadable: (error) => `status-board: 会話ログを読めません: ${error}`,
    noQuestion: '質問に答えてください',
    moreQuestions: (question, more) => `${question}（ほか ${more} 問）`,
    plan: (fresh, count) => `${fresh ? '計画を作成' : '計画を更新'}: ${count} ステップ`,
    recapAsk: (ask) => ` ／質問: ${ask}`,
    linked: (pr) => `${pr} を紐付け`,
    planSize: (count) => `計画 ${count} ステップ`,
    completedSteps: (count) => `完了 ${count}`,
    noRecord: 'まだ記録はありません。',
    noRecordYet: 'まだ記録はありません。指示や計画がここに並びます。',
    beforeFirstPrompt: '最初の指示より前',
    ask: (ask) => `質問: ${ask}`,
    asOf: (time) => `${time} 時点`,
    byModel: 'モデルによる要約',
    stale: 'その後に動きあり',
    usage: (read, output) => `読み ${read} / 出力 ${output}`,
    summarizing: '要約しています…',
    update: '状況ボードを更新する',
    create: '状況ボードを作る',
    cold: '（キャッシュ切れの可能性あり）',
    failed: (reason) => `要約できませんでした: ${reason}`,
    showHistory: '履歴を表示',
    hideHistory: '履歴を隠す',
    fewer: (shown) => `新しい ${shown} 件だけにする`,
    more: (count) => `さらに ${count} 件を表示`,
    cannotShow: (reason) => `状況ボードを表示できません: ${reason}`,
  },
}

function stepCount(count) {
  return `${count} ${count === 1 ? 'step' : 'steps'}`
}

// Values of Claude Code's free-text `language` setting, trimmed and lower-cased, that mean Japanese
const JAPANESE_NAMES = new Set(['ja', 'jp', 'jpn', 'japanese', '日本語'])

const PIPS = {
  completed: { glyph: '●', color: 'success' },
  in_progress: { glyph: '●', color: 'suggestion' },
  pending: { glyph: '○', color: 'inactive' },
  plan: { glyph: '●', color: 'suggestion' },
  recap: { glyph: '○', color: 'warning' },
  dialog: { glyph: '●', color: 'warning' },
  prompt: { glyph: '○', color: 'merged' },
  pr: { glyph: '○', color: 'suggestion' },
}

// Lines worth parsing, picked before JSON.parse: a transcript holds API request copies and tool
// results of hundreds of kilobytes a line
const PREFIX_MESSAGE = '{"parentUuid"'
const PREFIX_LAST_PROMPT = '{"type":"last-prompt"'
const PREFIX_PR_LINK = '{"type":"pr-link"'

// The transcript being read, as $.session.info() or classic.SessionStart named it
let path = ''
// Where the read stands: the byte offset of what was read, the bytes of a line cut by the end of
// the last read, and whether the line in hand is being dropped as too long
let reader = newReader()
// What the transcript has said so far
let data = newData()
// Bumped by every reset and switch of conversation, so a read begun before it stops at its next
// await instead of writing into the new state
let generation = 0
// The read in flight, and whether another was asked for while it ran: one at a time
let reading = null
let again = false
let ticker = null
let tickerMs = 0
// Whether the pane shows every card or the newest SHOWN
let showAll = false
// Reads that failed in a row since the last that succeeded
let failures = 0
// The conversation's id, which keys its board in $.store
let sessionId = ''
// The last board, { at, text, usage: { read, output } }, and why the last ask for one failed
let board = null
let boardError = null
// Numbers the asks for a board, so an answer to one begun before a reset or switch is dropped;
// `summarizing` is whether the latest still runs
let boardRuns = 0
let summarizing = false
// An answer ended while a board was being asked for, which that board may lack: once it is in,
// the board is asked for again if the pane is still shown
let summarizeAgain = false
// Whether a main turn runs, and when the last one ended: the cache is taken as warm then
let turnRunning = false
let lastTurnEnd = null
// Whether the pane shows the cards under the board
let historyShown = false
// The texts of the locale resolved at session.start, which render hooks and timers only read
let texts = TEXTS.en
// The formatter of the time zone resolved at session.start; the runtime's zone until then
let clockFormat = runtimeClock()

export function register(on) {
  // Fires again on an enable or a worker respawn, which may keep this module's variables
  on('session.start', async ($, e, next) => {
    texts = TEXTS.en
    clockFormat = runtimeClock()
    reset()
    // No read until the locale is known: event texts are built in it as the transcript is parsed
    path = ''
    showAll = false
    historyShown = false
    turnRunning = false
    lastTurnEnd = null
    ticker?.cancel()
    ticker = null
    tickerMs = 0
    const result = await next(e)
    // Before the command, whose description is localized, and before the first read, since event
    // texts are built as the transcript is parsed; the clock's zone with it
    texts = TEXTS[await resolveLocale($)]
    clockFormat = await resolveClock($)
    await $.command.register({ name: 'board', description: texts.commandDescription })
    path = (await $.session.info()).transcriptPath
    setStatus($, undefined)
    setTicker($, IDLE_TICK_MS)
    void refresh($)
    void startBoard($, await $.session.id(), true)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (FINAL_REASONS.includes(e.reason)) {
      generation += 1
      ticker?.cancel()
      ticker = null
      tickerMs = 0
    }
    return next(e)
  })

  // /resume, /clear and /branch move the conversation to another file; /compact keeps the file
  on('classic.SessionStart', { source: ['resume', 'clear', 'fork'] }, async ($, e, next) => {
    const result = await next(e)
    const nextPath = e.transcript_path || (await $.session.info()).transcriptPath
    const nextId = e.session_id || (await $.session.id())
    reset()
    path = nextPath
    // The conversation switched to has a cache of its own, not known to be warm
    turnRunning = false
    lastTurnEnd = null
    setStatus($, undefined)
    $.ui.invalidate('ui.render')
    void refresh($)
    // A branch is a new id with no board of its own yet
    void startBoard($, nextId, false, e.source !== 'fork')
    return result
  })

  // Neither hook waits on the file: the read runs beside the turn
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnRunning = true
      setTicker($, TURN_TICK_MS)
      $.clock.after(START_DELAY_MS, () => void refresh($))
    }
    return next(e)
  })

  // A finished answer refreshes the board while someone looks at it; never awaited
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    setTicker($, IDLE_TICK_MS)
    void refresh($)
    turnRunning = false
    lastTurnEnd = await $.clock.now()
    const result = await next(e)
    if (e.reason === 'answer') void summarizeIfShown($)
    return result
  })

  on('command.run', { command: 'board' }, async ($) => {
    const opened = await toggle($)
    return { text: opened ? texts.opened : texts.closed }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
    showAll = false
    historyShown = false
  }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const line = bandLine($, e, await $.clock.now())
    if (!line) return rest
    if (!rest) return line
    return $.ui.resolve(e).Box({ flexDirection: 'column', children: [line, rest] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    return paneBody($, e, await $.clock.now())
  })
}

// ---------------------------------------------------------------- the locale and the clock

// `en` or `ja`. The mods API carries no locale, and Intl answers en-US even on a Japanese macOS, so
// Claude Code's own `language` setting decides when it is set, whatever the environment says; then
// the first of LC_ALL, LC_MESSAGES and LANG that is set (the desktop app sets none of them); then,
// and on any failure of those reads, English.
async function resolveLocale($) {
  try {
    const language = await $.settings.read({ key: 'language' })
    if (typeof language === 'string' && language.trim() !== '') {
      const name = language.trim().toLowerCase()
      return JAPANESE_NAMES.has(name) || name.startsWith('ja-') || name.startsWith('ja_') ? 'ja' : 'en'
    }
    const variables = [await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')]
    const locale = variables.find((value) => typeof value === 'string' && value !== '')
    return locale?.toLowerCase().startsWith('ja') ? 'ja' : 'en'
  } catch {
    return 'en'
  }
}

// The formatter for TZ when it names a zone Intl knows; otherwise, POSIX forms such as JST-9 and
// :/etc/localtime included, or when the read fails, the runtime's own zone. Claude Code has no time
// zone setting of its own.
async function resolveClock($) {
  try {
    const zone = await $.env.get('TZ')
    if (typeof zone === 'string' && zone !== '') return new Intl.DateTimeFormat('en-GB', { ...CLOCK_OPTIONS, timeZone: zone })
  } catch {
    // An unknown zone throws a RangeError
  }
  return runtimeClock()
}

function runtimeClock() {
  return new Intl.DateTimeFormat('en-GB', CLOCK_OPTIONS)
}

// ---------------------------------------------------------------- reading the transcript

function newReader() {
  return { offset: 0, carry: null, dropping: false }
}

function newData() {
  // timeline: { ts, kind, text, to?, ask?, fresh?, steps? }, oldest first.
  // plan: [{ content, status }] as replayed; currentSince: when its in_progress step started.
  // prs: the pull request URLs linked so far. lastPrompt and lastPromptLeafId: the last-prompt
  // row, which names the text of a prompt whose own row is not marked as typed by a person.
  return { timeline: [], plan: [], currentSince: null, prs: new Set(), lastPrompt: null, lastPromptLeafId: null }
}

function reset() {
  generation += 1
  reader = newReader()
  data = newData()
  failures = 0
  boardRuns += 1
  summarizing = false
  summarizeAgain = false
  board = null
  boardError = null
}

// A read that fails FAILURES_SHOWN times in a row says so in the status line, until one succeeds;
// otherwise a band that never appears would give no clue why
function failed($, error) {
  failures += 1
  if (failures !== FAILURES_SHOWN) return
  const line = String(error?.message ?? error).split('\n')[0]
  setStatus($, texts.unreadable(line))
}

function succeeded($) {
  if (failures >= FAILURES_SHOWN) setStatus($, undefined)
  failures = 0
}

// A module being unloaded is refused its calls: the status is then dropped
function setStatus($, text) {
  try {
    void Promise.resolve($.ui.status(text)).catch(() => undefined)
  } catch {
    // Refused
  }
}

function setTicker($, ms) {
  if (ticker && tickerMs === ms) return
  ticker?.cancel()
  tickerMs = ms
  ticker = $.clock.every(ms, () => void refresh($))
}

// Reads what the transcript gained since the last read. Never awaited by a hook; a call while a
// read runs makes that read go round once more, so reads never overlap.
function refresh($) {
  if (reading) {
    again = true
    return reading
  }
  reading = (async () => {
    try {
      do {
        again = false
        const started = generation
        try {
          if (await readOnce($)) succeeded($)
        } catch (error) {
          // A read begun before a reset says nothing of the file read now
          if (started === generation) failed($, error)
          break
        }
      } while (again)
    } finally {
      reading = null
    }
  })()
  return reading
}

// Reads what was added since the last read. Resolves true once it read to the end, false when
// there was nothing to read yet or a reset overtook it; rejects when a read failed.
async function readOnce($) {
  const started = generation
  const file = path
  if (!file) return false
  let size
  try {
    const stat = await $.fs.stat(file)
    if (stat.kind !== 'file') return false
    size = stat.size
  } catch (error) {
    // The engine writes the file with the first prompt; until then there is nothing to read. A
    // missing file reads as `HooksError: <plugin>: $.fs.stat(<path>) failed: ENOENT` (probed on
    // 2.1.327); any other failure counts toward the status line
    if (isMissing(error)) return false
    throw error
  }
  if (started !== generation) return false
  let changed = false
  if (size < reader.offset) {
    // Rewritten from the start: read it all again
    reader = newReader()
    data = newData()
    changed = true
  }
  while (reader.offset < size) {
    const got = await $.fs.read(file, { as: 'bytes', offset: reader.offset, length: Math.min(CHUNK, size - reader.offset) })
    if (started !== generation) return false
    const bytes = fromBase64(got.base64)
    if (bytes.length === 0) break
    reader.offset += bytes.length
    if (consume(bytes)) changed = true
    if (reader.offset < size) {
      // A first read of a long transcript goes a chunk at a time, drawing as it goes
      if (changed) $.ui.invalidate('ui.render')
      changed = false
      await new Promise((resolve) => $.clock.after(0, resolve))
      if (started !== generation) return false
    }
  }
  if (changed) $.ui.invalidate('ui.render')
  return started === generation
}

function isMissing(error) {
  return error?.code === 'ENOENT' || /\bENOENT\b/.test(String(error?.message ?? error))
}

// Takes one chunk of bytes. Only whole lines are decoded: a newline byte is never part of a
// multibyte UTF-8 character, so a character cut by the chunk's end waits in `carry` with the rest
// of its line. Returns whether the timeline changed.
function consume(bytes) {
  const first = bytes.indexOf(10)
  if (first === -1) {
    hold(bytes)
    return false
  }
  let changed = false
  const head = reader.carry ? concat(reader.carry, bytes.subarray(0, first)) : bytes.subarray(0, first)
  if (!reader.dropping && handleLine(decode(head))) changed = true
  reader.carry = null
  reader.dropping = false
  const last = bytes.lastIndexOf(10)
  if (last > first) {
    for (const line of decode(bytes.subarray(first + 1, last)).split('\n')) {
      if (handleLine(line)) changed = true
    }
  }
  if (last + 1 < bytes.length) hold(bytes.subarray(last + 1))
  return changed
}

function hold(bytes) {
  if (reader.dropping) return
  const length = (reader.carry?.length ?? 0) + bytes.length
  if (length > CARRY_LIMIT) {
    reader.carry = null
    reader.dropping = true
    return
  }
  // A copy, so the chunk it came from is not kept alive
  reader.carry = reader.carry ? concat(reader.carry, bytes) : bytes.slice()
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

let decoder = null
function decode(bytes) {
  decoder ??= new TextDecoder()
  return decoder.decode(bytes)
}

function fromBase64(base64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(base64)
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------- the timeline

function clip(value, limit = TEXT_LIMIT) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function push(event) {
  data.timeline.push({ ...event, text: clip(event.text, event.kind === 'recap' ? RECAP_LIMIT : TEXT_LIMIT) })
  if (data.timeline.length > KEEP) data.timeline.shift()
}

function parse(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

// A prompt's text: a string, or text blocks. Unlike agent-dashboard, the reminders the engine
// adds to a prompt are left out: a session's first prompt in the desktop app carries a block that
// begins <system-reminder>, ahead of what the person typed
function promptText(content) {
  if (typeof content === 'string') return withoutReminders(content)
  if (!Array.isArray(content)) return ''
  return withoutReminders(
    content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string' && !b.text.trimStart().startsWith('<system-reminder>'))
      .map((b) => b.text)
      .join(' '),
  )
}

function withoutReminders(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

// Reads one line of the transcript into `data`; returns whether the timeline changed
function handleLine(line) {
  if (line.startsWith(PREFIX_MESSAGE)) {
    if (
      !line.includes('mcp__ccd_turn__') &&
      !line.includes('"promptSource"') &&
      !(line.includes('"tool_use"') && line.includes(`"${TOOL_DIALOG}"`))
    ) {
      return false
    }
    const rec = parse(line)
    // A subagent's rows are not this conversation's
    if (!rec || rec.isSidechain) return false
    const ts = Date.parse(rec.timestamp)
    if (Number.isNaN(ts)) return false
    if (rec.type === 'user') return handlePrompt(rec, ts)
    if (rec.type !== 'assistant' || !Array.isArray(rec.message?.content)) return false
    let changed = false
    for (const block of rec.message.content) {
      if (block?.type === 'tool_use' && handleToolUse(block, ts)) changed = true
    }
    return changed
  }
  if (line.startsWith(PREFIX_LAST_PROMPT)) {
    const rec = parse(line)
    if (typeof rec?.lastPrompt === 'string') {
      data.lastPrompt = withoutReminders(rec.lastPrompt)
      data.lastPromptLeafId = rec.leafUuid ?? null
    }
    return false
  }
  if (line.startsWith(PREFIX_PR_LINK)) {
    const rec = parse(line)
    if (typeof rec?.prUrl !== 'string' || data.prs.has(rec.prUrl)) return false
    // The same link is written again and again: only the first is an event
    data.prs.add(rec.prUrl)
    const ts = Date.parse(rec.timestamp)
    if (Number.isNaN(ts)) return false
    push({ ts, kind: 'pr', text: `PR #${rec.prNumber ?? '?'}` })
    return true
  }
  return false
}

// promptSource marks the input that began a turn (never a tool result); `system` is a plugin's,
// a task notice's or another session's, not a person's
function handlePrompt(rec, ts) {
  if (rec.promptSource === undefined || rec.promptSource === 'system' || rec.isMeta) return false
  const text =
    rec.origin?.kind === 'human'
      ? promptText(rec.message?.content)
      : typeof rec.uuid === 'string' && rec.uuid === data.lastPromptLeafId
        ? (data.lastPrompt ?? '')
        : ''
  if (!text) return false
  data.lastPrompt = text
  data.lastPromptLeafId = rec.uuid ?? null
  push({ ts, kind: 'prompt', text })
  return true
}

function handleToolUse(block, ts) {
  const input = block.input && typeof block.input === 'object' ? block.input : {}
  if (block.name === TOOL_DIALOG) {
    push({ ts, kind: 'dialog', text: dialogText(input.questions) })
    return true
  }
  if (block.name === TOOL_PLAN) {
    const next = applyPlanUpdate(data.plan, input)
    const events = planEvents(data.plan, next)
    for (const event of events) push({ ts, ...event })
    // The step in progress dates from the call that put it there
    const current = next.findIndex((s) => s.status === 'in_progress')
    const before = data.plan.findIndex((s) => s.status === 'in_progress')
    if (current === -1) data.currentSince = null
    else if (current !== before || data.plan[before].content !== next[current].content) data.currentSince = ts
    data.plan = next
    return events.length > 0
  }
  if (block.name === TOOL_WRAP) {
    push({ ts, kind: 'recap', text: clip(input.recap, RECAP_LIMIT), ask: input.ask ? clip(input.ask, RECAP_LIMIT) : null })
    // A wrap-up finishes the plan, unless it stops for the person's answer
    if (input.blocked !== true) {
      data.plan = data.plan.map((step) => ({ ...step, status: 'completed' }))
      data.currentSince = null
    }
    return true
  }
  return false
}

// The first question, and how many follow it
function dialogText(questions) {
  const asked = Array.isArray(questions) ? questions.map((q) => clip(q?.question)).filter(Boolean) : []
  if (asked.length === 0) return texts.noQuestion
  if (asked.length === 1) return asked[0]
  return texts.moreQuestions(asked[0], asked.length - 1)
}

// update_plan's input applied to the plan: `items` replaces it; `advance` completes the step in
// progress and starts the next pending one; `done` and `start` are 1-based
function applyPlanUpdate(plan, input) {
  if (Array.isArray(input.items)) {
    return input.items.map((item) => ({
      content: String(item?.content ?? ''),
      status: STATUSES.has(item?.status) ? item.status : 'pending',
    }))
  }
  const next = plan.map((step) => ({ ...step }))
  if (input.advance === true) {
    const current = next.find((s) => s.status === 'in_progress')
    if (current) current.status = 'completed'
    const upcoming = next.find((s) => s.status === 'pending')
    if (upcoming) upcoming.status = 'in_progress'
  }
  if (Array.isArray(input.done)) {
    for (const n of input.done) {
      const step = next[n - 1]
      if (step) step.status = 'completed'
    }
  }
  if (Number.isInteger(input.start)) {
    const step = next[input.start - 1]
    if (step) step.status = 'in_progress'
  }
  return next
}

// A plan whose steps changed is one event; otherwise each step whose status changed is one
function planEvents(prev, next) {
  const sameSteps = prev.length === next.length && prev.every((s, i) => s.content === next[i].content)
  if (!sameSteps) {
    const fresh = prev.length === 0 || prev.every((s) => s.status === 'completed')
    return [{ kind: 'plan', fresh, steps: next.length, text: texts.plan(fresh, next.length) }]
  }
  const events = []
  next.forEach((step, i) => {
    if (step.status !== prev[i].status) events.push({ kind: 'step', to: step.status, text: step.content })
  })
  return events
}

// ---------------------------------------------------------------- drawing

// An event's mark and its words: a dim label (Prompt, Recap, Question) and the rest
function eventParts(event) {
  const oneLine = (text) => text.replace(/\s+/g, ' ').trim()
  if (event.kind === 'step') {
    const to = texts.steps[event.to] ? event.to : 'pending'
    // The status leads, as a word too: the pip's color alone does not say it, and a narrow pane
    // cuts the end of the line
    return { pip: PIPS[to], label: texts.steps[to], text: oneLine(event.text) }
  }
  if (event.kind === 'recap') {
    const ask = event.ask ? texts.recapAsk(oneLine(event.ask)) : ''
    return { pip: PIPS.recap, label: texts.labels.recap, text: oneLine(event.text) + ask }
  }
  if (event.kind === 'pr') return { pip: PIPS.pr, label: null, text: texts.linked(event.text) }
  if (event.kind === 'prompt' || event.kind === 'dialog') {
    return { pip: PIPS[event.kind], label: texts.labels[event.kind], text: oneLine(event.text) }
  }
  return { pip: PIPS.plan, label: null, text: oneLine(event.text) }
}

// HH:MM today, M/D HH:MM otherwise, both the time and what counts as today in the clock's zone
function when(ts, now) {
  const d = clockParts(ts)
  const today = clockParts(now)
  const clock = `${d.hour}:${d.minute}`
  const sameDay = d.year === today.year && d.month === today.month && d.day === today.day
  return sameDay ? clock : `${d.month}/${d.day} ${clock}`
}

function clockParts(ms) {
  const parts = {}
  for (const part of clockFormat.formatToParts(ms)) parts[part.type] = part.value
  return parts
}

// What the band says: the step in progress with its place in the plan, else the newest event
function bandView(now) {
  if (data.timeline.length === 0) return null
  const current = data.plan.findIndex((s) => s.status === 'in_progress')
  if (current !== -1) {
    const step = data.plan[current]
    const text = step.content.replace(/\s+/g, ' ').trim()
    const label = `${texts.steps.in_progress} (${current + 1}/${data.plan.length})`
    return { pip: PIPS.in_progress, label, text, time: data.currentSince === null ? null : when(data.currentSince, now) }
  }
  const latest = data.timeline[data.timeline.length - 1]
  return { ...eventParts(latest), time: when(latest.ts, now) }
}

function bandLine($, e, now) {
  const view = bandView(now)
  if (!view) return null
  const { Box, Text, Button } = $.ui.resolve(e)
  const tail = view.time ? ` · ${view.time}` : ''
  let text = view.text
  if (e.surface === 'terminal') {
    // The pip and its space, the label, the time and the button ([ Status board ]) after a gap
    const fixed = 2 + (view.label ? width(view.label) + 1 : 0) + width(tail) + 1 + width(`[ ${texts.paneTitle} ]`)
    const room = (e.props.bodyColumns ?? 0) - BAND_RESERVED_COLUMNS - fixed
    if (room < 4) return null
    text = fit(text, room)
  } else {
    // Other surfaces cut the line themselves, but a long run might still push the button out
    text = fit(text, BAND_TEXT_CELLS)
  }
  return Box({
    key: 'status-board',
    flexDirection: 'row',
    columnGap: 1,
    alignItems: 'center',
    children: [
      Text({
        wrap: 'truncate-end',
        children: [
          Text({ color: view.pip.color, children: [view.pip.glyph] }),
          ' ',
          ...(view.label ? [Text({ dimColor: true, children: [view.label] }), ' '] : []),
          text,
          Text({ dimColor: true, children: [tail] }),
        ],
      }),
      Button({ key: 'status-board-toggle', label: texts.paneTitle, onPress: () => toggle($) }),
    ],
  })
}

// The pane's cards, oldest first: each person's prompt with everything up to the next one, so a
// turn a task notice or another session began lands on the card before it; what came before the
// first prompt makes a card with no prompt
function cardsOf(timeline) {
  const cards = []
  let card = null
  for (const event of timeline) {
    if (event.kind === 'prompt') {
      card = { prompt: event, events: [] }
      cards.push(card)
      continue
    }
    if (!card) {
      card = { prompt: null, events: [] }
      cards.push(card)
    }
    card.events.push(event)
  }
  return cards
}

// The plan and steps of a card folded into one line: the size of its last plan, the steps it
// completed, and the pull requests it linked
function cardFooter(card) {
  const parts = []
  const plans = card.events.filter((event) => event.kind === 'plan')
  const lastPlan = plans[plans.length - 1]
  if (lastPlan && typeof lastPlan.steps === 'number') parts.push(texts.planSize(lastPlan.steps))
  const completed = card.events.filter((event) => event.kind === 'step' && event.to === 'completed').length
  if (completed > 0) parts.push(texts.completedSteps(completed))
  for (const event of card.events) if (event.kind === 'pr') parts.push(event.text)
  return parts.join(' · ')
}

// Desktop rows from the pane cannot reach the conversation ($.ui.scroll answered every row with
// { deny: 'transcript not scrollable here' } on 2.1.326), so each card says in full what was
// asked, what came of it and what is asked back. Nothing in a card is a Button: the desktop app
// draws a Button's nested Text without its color.
function paneBody($, e, now) {
  const { Box, Text, Button, Markdown } = $.ui.resolve(e)
  // The board and its button are drawn even with no events: a conversation may have none (an
  // image alone typed in a terminal) and still be summed up
  const cards = cardsOf(data.timeline)
  const pip = (kind) => Text({ color: PIPS[kind].color, children: [PIPS[kind].glyph] })
  const time = (ts) => Text({ dimColor: true, children: [when(ts, now)] })
  const oneLine = (text) => text.replace(/\s+/g, ' ').trim()
  const newest = cards[cards.length - 1]

  // The small form may not take clicks: the newest card's latest recap, else its prompt
  if (e.props.placement === 'widget') {
    if (!newest) return Text({ dimColor: true, children: [texts.noRecord] })
    const recaps = newest.events.filter((event) => event.kind === 'recap')
    const shown = recaps[recaps.length - 1] ?? newest.prompt
    if (!shown) return Text({ dimColor: true, children: [texts.noRecord] })
    return Text({ maxLines: 3, children: [pip(shown.kind), ' ', time(shown.ts), ' ', shown.text.trim()] })
  }

  const cardBody = (card) => {
    const children = []
    children.push(
      card.prompt
        ? Text({ maxLines: 3, children: [pip('prompt'), ' ', time(card.prompt.ts), ' ', oneLine(card.prompt.text)] })
        : Text({ dimColor: true, children: [texts.beforeFirstPrompt] }),
    )
    for (const event of card.events) {
      if (event.kind === 'recap') {
        children.push(Text({ children: [pip('recap'), ' ', time(event.ts), ' ', event.text.trim()] }))
        if (event.ask) children.push(Text({ color: 'warning', children: [texts.ask(event.ask.trim())] }))
      } else if (event.kind === 'dialog') {
        children.push(Text({ children: [pip('dialog'), ' ', time(event.ts), ' ', Text({ dimColor: true, children: [texts.labels.dialog] }), ' ', event.text] }))
      }
    }
    const current = data.plan.findIndex((step) => step.status === 'in_progress')
    if (card === newest && current !== -1) {
      children.push(
        Text({
          children: [
            pip('in_progress'),
            ' ',
            Text({ dimColor: true, children: [`${texts.steps.in_progress} (${current + 1}/${data.plan.length})`] }),
            ' ',
            oneLine(data.plan[current].content),
          ],
        }),
      )
    }
    const footer = cardFooter(card)
    if (footer) children.push(Text({ dimColor: true, children: [footer] }))
    return Box({
      flexDirection: 'column',
      // On the desktop each card is framed, as pr-relay's cards are; the terminal spares the rows
      ...(e.surface === 'desktop' && { borderStyle: 'round', paddingX: 1 }),
      children,
    })
  }

  // The board leads: the model's summary of the whole session, then what it rests on
  const children = []
  if (board) {
    children.push(Markdown({ text: board.text }))
    const meta = [texts.asOf(when(board.at, now)), texts.byModel]
    if (isStale(board)) meta.push(texts.stale)
    if (board.usage) meta.push(texts.usage(tokens(board.usage.read), tokens(board.usage.output)))
    children.push(Text({ dimColor: true, children: [meta.join(' · ')] }))
  }
  const label = summarizing ? texts.summarizing : board ? texts.update : texts.create
  const warning = summarizing || isWarm(now) ? '' : texts.cold
  const action = [
    Button({
      key: 'status-board-refresh',
      label: label + warning,
      onPress: () => {
        if (!summarizing) void summarize($)
      },
    }),
  ]
  if (boardError) action.push(Text({ dimColor: true, children: [texts.failed(boardError)] }))
  children.push(Box({ flexDirection: 'column', children: action }))
  children.push(
    Button({
      key: 'status-board-history',
      plain: true,
      dimColor: true,
      label: historyShown ? texts.hideHistory : texts.showHistory,
      onPress: () => {
        historyShown = !historyShown
        $.ui.invalidate('ui.render')
      },
    }),
  )
  if (!historyShown) return Box({ flexDirection: 'column', rowGap: 1, children })
  if (cards.length === 0) children.push(Text({ dimColor: true, children: [texts.noRecordYet] }))

  const newestFirst = [...cards].reverse()
  const shown = showAll ? newestFirst : newestFirst.slice(0, SHOWN)
  children.push(...shown.map(cardBody))
  if (cards.length > SHOWN) {
    children.push(
      Button({
        key: 'status-board-more',
        plain: true,
        dimColor: true,
        label: showAll ? texts.fewer(SHOWN) : texts.more(cards.length - SHOWN),
        onPress: () => {
          showAll = !showAll
          $.ui.invalidate('ui.render')
        },
      }),
    )
  }
  return Box({ flexDirection: 'column', rowGap: 1, children })
}

// Opens the pane, or closes it when it is open. The engine's list is the one to trust: the pane
// outlives a reload of this module. Returns whether it is open now.
async function toggle($) {
  if ((await $.ui.panes()).some((pane) => pane.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  const opened = await $.ui.open({ id: PANE, title: texts.paneTitle })
  if (!opened.isPlaced) {
    // Nobody would see a board asked for now
    $.ui.toast(texts.cannotShow(opened.reason))
    return true
  }
  // A missing or outdated board is asked for only on a warm cache; otherwise the button waits
  const now = await $.clock.now()
  if ((!board || isStale(board)) && isWarm(now)) void summarize($)
  return true
}

// ---------------------------------------------------------------- the board

function isWarm(now) {
  return turnRunning || (lastTurnEnd !== null && now - lastTurnEnd <= WARM_MS)
}

// Something happened after the board was written: an event, or a turn that ended, since in a
// terminal session a plain answer is no event
function isStale(written) {
  const latest = data.timeline[data.timeline.length - 1]
  if (latest !== undefined && latest.ts > written.at) return true
  return lastTurnEnd !== null && lastTurnEnd > written.at
}

// Takes up the conversation `id`: its board from the store unless `load` is false, and, at
// session.start (`prune`), deletes the boards nobody wrote for STALE_MS
async function startBoard($, id, prune, load = true) {
  const run = boardRuns
  sessionId = id
  try {
    const stored = load ? await $.store.get(BOARD_PREFIX + id) : null
    if (run === boardRuns && isBoard(stored)) {
      board = stored
      $.ui.invalidate('ui.render')
    }
    if (!prune) return
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(BOARD_PREFIX)) continue
      const value = await $.store.get(key)
      if (!isBoard(value) || now - value.at > STALE_MS) await $.store.delete(key)
    }
  } catch {
    // A store that cannot be read leaves the board empty; the next ask writes it again
  }
}

function isBoard(value) {
  return typeof value === 'object' && value !== null && typeof value.at === 'number' && typeof value.text === 'string'
}

// Only a pane a surface places and shows is looked at
async function summarizeIfShown($) {
  try {
    if ((await $.ui.panes()).some((pane) => pane.id === PANE && pane.isPlaced && pane.isShown)) await summarize($, true)
  } catch {
    // Unloading
  }
}

// Asks the model for a board over the session's own transcript, one ask at a time. An answer to
// an ask begun before a reset or a switch of conversation is dropped. A failure keeps the board
// there was and says why under the button. An ask from a turn's end (`auto`) while one runs is
// made again once that one is in; a press while one runs does nothing.
async function summarize($, auto = false) {
  if (summarizing) {
    if (auto) summarizeAgain = true
    return
  }
  const run = ++boardRuns
  summarizing = true
  boardError = null
  $.ui.invalidate('ui.render')
  try {
    const at = await $.clock.now()
    const id = sessionId
    // The fork sees the turn's final answer too, and raises no turn events of its own, so a board
    // asked for at turn.complete asks for no other (probed with `claude -p` on 2.1.327)
    const reply = await $.model.fork({ prompt: texts.boardPrompt })
    if (run !== boardRuns) return
    if (reply.isAnswered) {
      const usage = reply.usage
      board = {
        at,
        text: reply.text.trim(),
        usage: {
          read: (usage.cache_read_input_tokens ?? 0) + (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          output: usage.output_tokens ?? 0,
        },
      }
      await $.store.set(BOARD_PREFIX + id, board).catch(() => undefined)
    } else if (reply.reason !== 'nothing-to-fork') {
      // Before the first turn ends there is nothing to sum up, which is no failure
      boardError = reply.reason === 'api-error' ? `${reply.reason} ${reply.status ?? ''}`.trim() : reply.reason
    }
  } catch (error) {
    if (run === boardRuns) boardError = String(error?.message ?? error).split('\n')[0]
  } finally {
    if (run === boardRuns) {
      summarizing = false
      $.ui.invalidate('ui.render')
      if (summarizeAgain) {
        summarizeAgain = false
        void summarizeIfShown($)
      }
    }
  }
}

// 321578 as 322k
function tokens(count) {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count)
}

// Terminal cells: East Asian wide and fullwidth characters take two
function width(text) {
  let cells = 0
  for (const char of text) cells += wide(char.codePointAt(0)) ? 2 : 1
  return cells
}

function wide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

// The text cut to `cells` terminal cells, an ellipsis marking the cut
function fit(text, cells) {
  if (width(text) <= cells) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const w = wide(char.codePointAt(0)) ? 2 : 1
    if (used + w > cells - 1) break
    out += char
    used += w
  }
  return out + '…'
}
