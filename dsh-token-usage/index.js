// @kelearns/dsh-token-usage — host face (token activity heatmap).
// Reads logical events through DSH's SessionPersistence service so storage
// generations, compression, and backend selection stay owned by DSH.

export const name = 'dsh-token-usage'
export const inject = ['webServer', 'timer', 'sessionPersistence']

const MAX_PAGE_EVENTS = 1024
const MAX_SCAN_SESSIONS = 20000
const JSON_HEADERS = { 'content-type': 'application/json' }

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Local-time YYYY-MM-DD. */
function dayKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '-' + month + '-' + day
}

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function latestStreamUsage(stream) {
  if (!Array.isArray(stream)) return null
  let latest = null
  for (const record of stream) {
    const chunk = record && record.chunk
    if (chunk && chunk.type === 'usage' && isRecord(chunk.usage)) {
      latest = { usage: chunk.usage, time: record.time }
    }
  }
  return latest
}

function createFold(createdAt) {
  return {
    days: new Map(),
    modelCounts: new Map(),
    reasoningCounts: new Map(),
    toolCounts: new Map(),
    hourCounts: new Map(),
    weekdayCounts: new Map(),
    events: 0,
    errors: 0,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
    maxEventTime: 0,
  }
}

function addCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1)
}

function addUsage(folded, usage, time) {
  if (!isRecord(usage) || typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return
  const input = tokenCount(usage.inputTokens)
  const output = tokenCount(usage.outputTokens)
  const cacheRead = tokenCount(usage.cacheReadTokens)
  const cacheWrite = tokenCount(usage.cacheWriteTokens)
  if (input + output + cacheRead + cacheWrite === 0) return

  const date = new Date(time)
  addCount(folded.hourCounts, date.getHours())
  addCount(folded.weekdayCounts, date.getDay())
  const key = dayKey(time)
  const row = folded.days.get(key)
  if (row) {
    row[0] += input
    row[1] += output
    row[2] += cacheRead
    row[3] += cacheWrite
  } else {
    folded.days.set(key, [input, output, cacheRead, cacheWrite])
  }
}

/** Fold current Session events plus the released assistant/chunk vocabulary. */
function foldEvents(events, folded) {
  for (const event of events) {
    folded.events += 1
    if (!isRecord(event) || !isRecord(event.data)) {
      folded.errors += 1
      continue
    }
    if (typeof event.time === 'number' && event.time > folded.maxEventTime) {
      folded.maxEventTime = event.time
    }

    if (event.type === 'request/header') {
      const config = event.data.header && event.data.header.config
      if (config) {
        if (typeof config.model === 'string' && config.model) addCount(folded.modelCounts, config.model)
        if (typeof config.reasoningEffort === 'string' && config.reasoningEffort) {
          addCount(folded.reasoningCounts, config.reasoningEffort)
        }
      }
      continue
    }
    if (event.type === 'tool/call') {
      if (typeof event.data.name === 'string' && event.data.name) addCount(folded.toolCounts, event.data.name)
      continue
    }

    if (event.type === 'assistant/message') {
      const streamed = latestStreamUsage(event.data.stream)
      const usage = isRecord(event.data.usage) ? event.data.usage : streamed && streamed.usage
      addUsage(folded, usage, streamed && typeof streamed.time === 'number' ? streamed.time : event.time)
      continue
    }
    if (event.type === 'assistant/attempt') {
      const streamed = latestStreamUsage(event.data.stream)
      if (streamed) {
        addUsage(folded, streamed.usage,
          typeof streamed.time === 'number' ? streamed.time : event.time)
      }
      continue
    }

    // Compaction summaries are model calls too, but do not emit a normal
    // assistant/message settlement into the conversation surface.
    if (event.type === 'compaction/summary') {
      addUsage(folded, event.data.usage, event.time)
      continue
    }

    // Historical event shape retained by the adjacent DSH session migrations.
    if (event.type === 'assistant/chunk' && event.data.chunk && event.data.chunk.type === 'usage') {
      addUsage(folded, event.data.chunk.usage, event.time)
    }
  }
}

function finishFold(folded) {
  return {
    ...folded,
    durationMs: folded.createdAt > 0 && folded.maxEventTime > folded.createdAt
      ? folded.maxEventTime - folded.createdAt
      : 0,
  }
}

async function readSession(persistence, snapshot, signal) {
  const folded = createFold(snapshot.header.createdAt)
  const eventCount = Number.isSafeInteger(snapshot.eventCount) && snapshot.eventCount >= 0
    ? snapshot.eventCount
    : null
  if (eventCount === 0) return finishFold(folded)

  const handle = await persistence.open(snapshot.header.id, 'read', { signal })
  try {
    let offset = 0
    for (;;) {
      signal.throwIfAborted()
      if (eventCount !== null && offset >= eventCount) break
      const length = eventCount === null
        ? MAX_PAGE_EVENTS
        : Math.min(MAX_PAGE_EVENTS, eventCount - offset)
      const result = await handle.read(offset, length, { signal })
      const events = result.events
      if (events.length === 0) break
      foldEvents(events, folded)
      offset += events.length
      if (events.length < length) break
    }
  } finally {
    await handle.close()
  }
  return finishFold(folded)
}

function topByCount(map) {
  let best = null
  let bestCount = 0
  for (const [name, count] of map) {
    if (count > bestCount) {
      best = name
      bestCount = count
    }
  }
  return best === null ? null : { name: best, count: bestCount }
}

function dateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '-' + month + '-' + day
}

function nextDayKey(key) {
  const [year, month, day] = key.split('-').map(Number)
  return dateKey(new Date(year, month - 1, day + 1))
}

function computeStats(days) {
  let peakDay = null
  for (const row of days) {
    if (!peakDay || row.a > peakDay.a) peakDay = { d: row.d, a: row.a }
  }

  let longestStreak = 0
  let currentStreak = 0
  if (days.length > 0) {
    const usage = new Set(days.map((row) => row.d))
    let run = 0
    let cursor = days[0].d
    const last = days[days.length - 1].d
    while (cursor <= last) {
      if (usage.has(cursor)) {
        run += 1
        if (run > longestStreak) longestStreak = run
      } else {
        run = 0
      }
      cursor = nextDayKey(cursor)
    }

    const today = new Date()
    let walk = today
    if (!usage.has(dateKey(walk))) walk = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
    while (usage.has(dateKey(walk))) {
      currentStreak += 1
      walk = new Date(walk.getFullYear(), walk.getMonth(), walk.getDate() - 1)
    }
  }
  return { peakDay, longestStreak, currentStreak }
}

function mergeCounts(target, source) {
  for (const [key, value] of source) target.set(key, (target.get(key) || 0) + value)
}

export function apply(ctx, config = {}) {
  const refreshMinutes = Number(config.refreshIntervalMinutes)
  const refreshIntervalMs = Number.isFinite(refreshMinutes) && refreshMinutes > 0
    ? refreshMinutes * 60 * 1000
    : 5 * 60 * 1000
  const scanController = new AbortController()
  const cache = new Map() // session id -> { revision, folded }
  let cacheServiceIdentity
  let lastScan = null
  let scanInFlight = null

  ctx.effect(() => () => scanController.abort(), 'dsh-token-usage: scan lifecycle')

  function scanNow(force = false) {
    if (scanInFlight) return scanInFlight
    scanInFlight = (async () => {
      const started = Date.now()
      const persistence = ctx.sessionPersistence
      const identity = persistence.identity
      if (cacheServiceIdentity !== identity) {
        cache.clear()
        cacheServiceIdentity = identity
      }

      const listed = await persistence.list({ signal: scanController.signal })
      const ordered = [...listed].sort((left, right) => {
        const byTime = (right.header.createdAt || 0) - (left.header.createdAt || 0)
        return byTime || String(left.header.id).localeCompare(String(right.header.id))
      })
      const snapshots = ordered.slice(0, MAX_SCAN_SESSIONS)
      const truncatedSessions = Math.max(0, ordered.length - snapshots.length)
      const alive = new Set(snapshots.map((snapshot) => String(snapshot.header.id)))
      let sessionsScanned = 0
      let sessionsCached = 0
      let sessions = 0
      let events = 0
      let errors = 0
      let longestSessionMs = 0
      const dayTotals = new Map()
      const modelCounts = new Map()
      const reasoningCounts = new Map()
      const toolCounts = new Map()
      const hourCounts = new Map()
      const weekdayCounts = new Map()

      const addDay = (key, row) => {
        const total = dayTotals.get(key)
        if (total) {
          total[0] += row[0]
          total[1] += row[1]
          total[2] += row[2]
          total[3] += row[3]
        } else {
          dayTotals.set(key, [...row])
        }
      }

      for (const snapshot of snapshots) {
        scanController.signal.throwIfAborted()
        const id = String(snapshot.header.id)
        const hit = cache.get(id)
        let folded
        if (!force && hit && hit.revision === snapshot.revision) {
          folded = hit.folded
          sessionsCached += 1
        } else {
          try {
            folded = await readSession(persistence, snapshot, scanController.signal)
            cache.set(id, { revision: snapshot.revision, folded })
            sessionsScanned += 1
          } catch (error) {
            if (scanController.signal.aborted) throw error
            cache.delete(id)
            errors += 1
            continue
          }
        }

        sessions += 1
        events += folded.events
        if (folded.durationMs > longestSessionMs) longestSessionMs = folded.durationMs
        for (const [key, row] of folded.days) addDay(key, row)
        mergeCounts(modelCounts, folded.modelCounts)
        mergeCounts(reasoningCounts, folded.reasoningCounts)
        mergeCounts(toolCounts, folded.toolCounts)
        mergeCounts(hourCounts, folded.hourCounts)
        mergeCounts(weekdayCounts, folded.weekdayCounts)
      }

      for (const id of cache.keys()) if (!alive.has(id)) cache.delete(id)
      const days = [...dayTotals.entries()]
        .map(([d, row]) => ({
          d,
          i: row[0],
          o: row[1],
          c: row[2],
          w: row[3],
          a: row[0] + row[1] + row[2] + row[3],
        }))
        .sort((left, right) => left.d < right.d ? -1 : left.d > right.d ? 1 : 0)

      let input = 0
      let output = 0
      let cacheRead = 0
      let cacheWrite = 0
      for (const row of days) {
        input += row.i
        output += row.o
        cacheRead += row.c
        cacheWrite += row.w
      }

      lastScan = {
        at: Date.now(),
        sessionsScanned,
        sessionsCached,
        sessions,
        events,
        errors,
        truncatedSessions,
        durationMs: Date.now() - started,
      }
      const stats = computeStats(days)
      const activeMonths = new Set(days.map((row) => row.d.slice(0, 7))).size
      const totalAll = input + output + cacheRead + cacheWrite
      return {
        generatedAt: Date.now(),
        source: 'sessionPersistence',
        scan: { ...lastScan },
        totals: { input, output, cacheRead, cacheWrite, all: totalAll, days: days.length },
        stats: {
          ...stats,
          longestSessionMs,
          activeDays: days.length,
          activeMonths,
        },
        insights: {
          topModel: topByCount(modelCounts),
          topReasoning: topByCount(reasoningCounts),
          topTool: topByCount(toolCounts),
          peakHour: topByCount(hourCounts),
          topWeekday: topByCount(weekdayCounts),
          avgDaily: days.length > 0 ? Math.round(totalAll / days.length) : 0,
          avgMonthly: activeMonths > 0 ? Math.round(totalAll / activeMonths) : 0,
        },
        today: dayKey(Date.now()),
        days,
      }
    })().finally(() => {
      scanInFlight = null
    })
    return scanInFlight
  }

  const writeJson = (res, status, payload) => {
    res.writeHead(status, JSON_HEADERS)
    res.end(JSON.stringify(payload))
  }

  ctx.effect(() => {
    const disposers = []
    try {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-token-usage/stats',
        handler: async (_req, res) => {
          try {
            const data = await scanNow(false)
            writeJson(res, 200, { ok: true, data })
          } catch (error) {
            writeJson(res, 502, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-token-usage/refresh',
        handler: async (_req, res) => {
          try {
            const data = await scanNow(true)
            writeJson(res, 200, { ok: true, data })
          } catch (error) {
            writeJson(res, 502, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-token-usage/status',
        handler: async (_req, res) => {
          writeJson(res, 200, {
            ok: true,
            data: {
              source: 'sessionPersistence',
              lastScan,
              cachedSessions: cache.size,
              refreshIntervalMs,
            },
          })
        },
      }))
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'dsh-token-usage: routes')

  ctx.interval(() => {
    void scanNow(false).catch(() => {})
  }, refreshIntervalMs)
  void scanNow(false).catch(() => {})
}
