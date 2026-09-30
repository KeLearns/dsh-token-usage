// dsh-token-usage host test: mock SessionPersistence + synthetic current and legacy events
// Run: node test/mock.test.mjs
import { apply } from '../index.js'

let failures = 0
const assert = (condition, message) => {
  if (condition) console.log('  PASS:', message)
  else { failures++; console.error('  FAIL:', message) }
}

function event(type, time, data) {
  return { type, seq: 0, time, data }
}

function usage(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

const T1 = new Date(2026, 6, 13, 10, 0, 0).getTime() // Monday
const T2 = new Date(2026, 6, 13, 11, 0, 0).getTime()
const T3 = new Date(2026, 6, 14, 9, 0, 0).getTime()
const T4 = new Date(2026, 6, 14, 9, 30, 0).getTime()

const sessions = [
  {
    header: { id: 'sess-a', createdAt: T1 },
    events: [
      event('assistant/message', T1, {
        turn: 1, step: 1, stream: [], message: { content: [] },
        usage: usage(1000, 500, 200, 100),
      }),
      // Retained historical vocabulary; the current persistence service may
      // migrate legacy files before they reach a consumer.
      event('assistant/chunk', T2, {
        turn: 1, step: 1,
        chunk: { type: 'usage', usage: usage(2000, 300, 100, 50) },
      }),
    ],
  },
  {
    header: { id: 'sess-b', createdAt: T3 },
    events: [
      event('assistant/attempt', T3, {
        turn: 1,
        step: 1,
        stream: [
          { type: 'chunk', time: T3 - 1, chunk: { type: 'usage', usage: usage(9999, 9999, 9999, 9999) } },
          { type: 'chunk', time: T3, chunk: { type: 'usage', usage: usage(4000, 700, 50, 25) } },
        ],
      }),
      event('compaction/summary', T4, {
        compactionId: 'compact-1',
        provider: 'mock',
        model: 'mock-model',
        summary: [],
        usage: usage(40, 20, 5, 10),
      }),
    ],
  },
  // A session with no usage is still a successfully scanned session.
  { header: { id: 'sess-empty', createdAt: T4 + 1 }, events: [] },
]

const snapshots = sessions.map((session) => ({
  header: session.header,
  revision: `revision:${session.header.id}:1`,
  eventCount: session.events.length,
}))
const disposers = []
const routes = []
const ctx = {
  routes,
  effect(setup) {
    const dispose = setup()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  interval(callback) {
    void callback
    const dispose = () => {}
    disposers.push(dispose)
    return dispose
  },
  webServer: {
    register(spec) {
      routes.push(spec)
      return () => {
        const index = routes.indexOf(spec)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
  sessionPersistence: {
    identity: Symbol('test persistence'),
    async list() { return snapshots },
    async open(id, access) {
      if (access !== 'read') throw new Error('test only supports read handles')
      const session = sessions.find((item) => item.header.id === id)
      if (!session) throw new Error(`unknown session: ${id}`)
      let closed = false
      return {
        async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options = {}) {
          options.signal?.throwIfAborted()
          if (closed) throw new Error('handle closed')
          return { eventState: 'owned', events: session.events.slice(offset, offset + length) }
        },
        async close() { closed = true },
      }
    },
  },
}

async function invoke(route, req = {}) {
  let status = 0
  let body = ''
  const res = {
    writeHead(value) { status = value },
    end(value) { body = value },
  }
  await route.handler(req, res)
  return { status, body: JSON.parse(body) }
}

try {
  apply(ctx)
  const statsRoute = routes.find((route) => route.path === '/dsh-token-usage/stats')
  assert(!!statsRoute, 'stats route registered')
  const { status, body } = await invoke(statsRoute)
  assert(status === 200, 'stats returns 200')
  assert(body.ok === true, 'ok field')
  const data = body.data
  console.log('  totals:', JSON.stringify(data.totals), 'days=', JSON.stringify(data.days))
  assert(data.totals.input === 7040, 'input includes successful, retried, legacy, and compaction usage')
  assert(data.totals.output === 1520, 'output includes every reported model call')
  assert(data.totals.cacheRead === 355, 'cache-read tokens included')
  assert(data.totals.cacheWrite === 185, 'cache-write tokens included')
  assert(data.totals.all === 9100, 'total sums the four disjoint token buckets')
  assert(data.days.length === 2, 'two local calendar days')
  assert(data.days[0].d === '2026-07-13' && data.days[0].a === 4250, 'July 13 total includes the final and legacy events')
  assert(data.days[1].d === '2026-07-14' && data.days[1].a === 4850, 'July 14 total includes retry and compaction usage')
  assert(data.scan.sessions === 3, 'empty session is counted as scanned')
  assert(data.scan.errors === 0, 'no session read errors')
  assert(typeof data.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.today), 'today format')
  assert(data.stats.peakDay.d === '2026-07-14' && data.stats.peakDay.a === 4850, 'peak day is July 14')
  assert(data.stats.longestSessionMs === 3600000, 'longest session duration is one hour')
  assert(data.stats.longestStreak === 2, 'longest active streak is two days')
  assert(data.stats.activeDays === 2, 'two active days')

  const { body: cached } = await invoke(statsRoute)
  assert(cached.data.scan.sessionsScanned === 0 && cached.data.scan.sessionsCached === 3, 'unchanged session revisions hit cache')

  const refreshRoute = routes.find((route) => route.path === '/dsh-token-usage/refresh')
  const { body: refreshed } = await invoke(refreshRoute)
  assert(refreshed.data.scan.sessionsScanned === 3, 'forced refresh rereads all sessions')
} finally {
  for (const dispose of disposers.reverse()) dispose()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
