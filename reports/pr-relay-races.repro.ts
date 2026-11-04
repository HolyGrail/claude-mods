
// ---- Reproductions for reports/pr-relay-races.md ----
// It uses stubWorld and the constants from plugins/pr-relay/tests/pr-relay.test.ts, so run it after
// that file's helpers (its first 378 lines); see "3. 再現の方法" in the report. Each test asserts
// the racy outcome as it happens today, so a fix turns it red.

const R_NOTE = 'poll:session-b:' + URL.toLowerCase()
const R_RECORD = 'pr:' + URL.toLowerCase()
const rPollNote = (at: number, pr = URL.toLowerCase()) => ({ pr, at })

// R1 (#26 item 1): the idle write of session.end is lost and the note stays running
test('RACE R1: a refused retirement write on session.end leaves the note running in the store', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let slow = false
  const w = stubWorld(on, { answers: async () => { if (slow) await clock.sleep(5 * MINUTE) } })
  on('session.end', () => ({ sessionId: 'session-b' }))
  await $.session.start(START)
  await clock.settle()
  // The next poll is mid-query when the session ends
  slow = true
  await clock.advance(MINUTE)
  expect(w.store.get(R_NOTE)).toMatchObject({ running: true })
  w.sets = async (key) => {
    if (key === R_NOTE) throw new Error('store busy')
  }
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-b', resume: { id: 'session-b' } })
  w.sets = undefined
  expect(w.store.get(R_NOTE)).toMatchObject({ running: true })
  expect((w.store.get(R_NOTE) as { idle?: boolean }).idle).toBeUndefined()

  // What a running note does to the other sessions for RUNNING_MS is shown by the existing tests
  // 'a poll of another session still running past its round keeps holding back later ones' and
  // 'a poll left running by a session that died holds nothing back for long'
  // Let the slow query finish inside the test
  await clock.advance(5 * MINUTE)
})

// R4 (#26 item 4): the last scan of the notes is not a snapshot
test('RACE R4: a push note that lands during the final scan of the notes is missed and the review is relayed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const OTHER = 'poll:session-a:' + URL.toLowerCase()
  const LATE_KEY = 'poll:session-z:' + URL.toLowerCase()
  const w = stubWorld(on)
  w.store.set(OTHER, { ...rPollNote(NOW - 20 * MINUTE), idle: true })
  await $.session.start(START)
  await clock.settle()

  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  let reads = 0
  w.gets = async (key) => {
    // The third read of the other note is the final scan; a push of a fourth session lands now
    if (key === OTHER && ++reads === 3) {
      w.store.set(LATE_KEY, { ...rPollNote(NOW + MINUTE), idle: true, pending: [{ id: 'x', at: NOW + MINUTE, head: 'a1', running: true }] })
    }
  }
  await clock.advance(MINUTE)
  expect(reads).toBe(3)
  // The running push was in the store before the prompt went out, but the scan had listed the keys already
  expect(w.store.has(LATE_KEY)).toBe(true)
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
  w.gets = undefined
})

// R5 (#26 item 5): a rollback after a late record write removes the successor's mark
test('RACE R5: a record write that lands past the lease rolls back a successor\'s mark and the review is sent twice', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  let slow = true
  w.sets = async (key) => {
    if (key === R_RECORD && slow) {
      slow = false
      await clock.sleep(10.5 * MINUTE)
    }
  }
  await clock.advance(MINUTE)
  // Ten minutes later another session takes the round over, relays the review and marks it
  await clock.advance(10.2 * MINUTE - MINUTE)
  const successor = { ...(w.store.get(R_RECORD) as object), reviews: ['1'], at: NOW + 10.2 * MINUTE }
  w.store.set(R_RECORD, successor)
  const successorPrompts = 1
  // This session's write lands late at +11.5 min, so it takes back the mark, which was also the successor's
  await clock.advance(1.5 * MINUTE)
  await clock.advance(2 * MINUTE)
  // The same review now wakes this session too
  expect(successorPrompts + w.prompts.length).toBe(2)
  w.sets = undefined
})

// N1: a take-back's read-modify-write lands over another session's newer mark
test('RACE N1: a take-back of a dropped prompt erases another session\'s mark written meanwhile', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let armed = false
  const w = stubWorld(on, {
    turnStarts: async () => {
      armed = true
      await clock.sleep(5_000)
    },
  })
  await $.session.start(START)
  await clock.settle()

  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  w.dropPrompt = true
  w.gets = async (key) => {
    // The take-back reads the record; before it writes, another session's poll marks review 2
    if (key === R_RECORD && armed) {
      armed = false
      w.store.set(R_RECORD, { ...(w.store.get(R_RECORD) as object), reviews: ['1', '2'] })
      w.pull.reviews = [...(w.pull.reviews ?? []), { id: 2, at: NOW + 40_000, comments: 1 }]
    }
  }
  await clock.advance(MINUTE)
  // The prompt waits 5 s for its turn and is dropped, then its mark is taken back
  await clock.advance(10_000)
  // Review 2's mark, written by the other session, is gone
  expect((w.store.get(R_RECORD) as { reviews: string[] }).reviews).toEqual([])
  w.gets = undefined
  w.dropPrompt = false
  w.prompts = []
  await clock.advance(MINUTE)
  // So review 2, which the other session already relayed, is relayed again here
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 2 件')])
})

// N2: two processes resuming the same conversation share one note key and both relay
test('RACE N2: a running note under this session\'s own key (same id in another process) holds nothing back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  // The other process started its poll a second earlier and is still waiting on GitHub
  w.store.set(R_NOTE, { ...rPollNote(NOW - 1_000), running: true })
  await $.session.start(START)
  await clock.settle()
  // With any other key this session would yield; here it relays as well
  expect(w.prompts.length).toBe(1)
})

// N3: the elected session's queued prompt dies with the session, but its mark stays
test('RACE N3: a prompt still queued when the leader session ends leaves its mark, and nobody sends it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { turnStarts: () => new Promise<void>(() => {}) })
  on('session.end', () => ({ sessionId: 'session-b' }))
  await $.session.start(START)
  await clock.settle()
  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(1)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-b', resume: { id: 'session-b' } })
  expect((w.store.get(R_RECORD) as { reviews: string[] }).reviews).toEqual(['1'])

  // Another session on the same pull request never gets it
  w.sessionId = 'session-c'
  w.prompts = []
  w.turnStarts = async () => {}
  await $.session.start(START)
  await clock.settle()
  await clock.advance(3 * MINUTE)
  expect(w.prompts).toEqual([])
})

// N6: notes of past session ids pile up, and every poll reads each of them in turn three times
test('RACE N6: notes of past sessions are read one after another on every poll', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  for (let i = 0; i < 200; i++) w.store.set(`poll:old-${String(i).padStart(3, '0')}:${URL.toLowerCase()}`, { ...rPollNote(NOW - 3 * 24 * 60 * MINUTE), idle: true })
  let gets = 0
  w.gets = async (key) => {
    if (key.startsWith('poll:old-')) {
      gets++
      await clock.sleep(5)
    }
  }
  await $.session.start(START)
  await clock.settle()
  gets = 0
  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  await clock.advance(MINUTE)
  // Three scans of 200 notes, each read in turn: 3 s of store reads at 5 ms a read
  expect(gets).toBe(600)
  // None of them was pruned: they belong to other session ids of a pull request still open
  expect([...w.store.keys()].filter((k) => k.startsWith('poll:old-')).length).toBe(200)
  w.gets = undefined
})
