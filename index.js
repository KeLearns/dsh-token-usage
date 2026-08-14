// @kelearns/dsh-token-usage — host 半端（Token 用量热力图，零依赖）
//
// 数据源：$DSH_HOME/sessions/<workspace>/<session-id>/session.jsonl.zstd
// （DSH 官方 JSONL 持久化格式：多个 zstd 帧首尾相连，每帧 = 一次批量追加，
//   帧内为 JSONL：首行 session 头，后续为会话事件流）。
// 聚合：逐文件扫描 assistant/chunk 事件中 chunk.type === "usage" 的
//   usage { inputTokens, outputTokens, cacheReadTokens, reasoningTokens }，
//   按事件 time（epoch ms，进程本地时区）归入自然日。
// 缓存：按 (size, mtimeMs) 识别文件是否变化，未变的会话直接复用已解析
//   的逐日聚合，重复扫描只重解变化中的文件（活跃会话）。
//
// 路由（同源，前缀 /dsh-token-usage）：
//   GET  /dsh-token-usage/stats   —— 全量统计（每日数组 + 总量 + 会话数）
//   POST /dsh-token-usage/refresh —— 强制失效缓存并重扫
// 定时：config.refreshIntervalMinutes（默认 5）自动重扫变化文件。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-token-usage'
export const inject = ['webServer', 'timer']

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 (LE)
const MAX_DECODED_BYTES = 512 * 1024 * 1024 // 单文件解压上限，防失控
const MAX_SCAN_FILES = 20000 // 会话文件数上限兜底
const JSON_HEADERS = { 'content-type': 'application/json' }

/** 本地时区的 YYYY-MM-DD（补零）。 */
function dayKey(ms) {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * 扫描 zstd 帧边界（与 DSH dsh-session-persistence-jsonl 的 scanZstdFrames
 * 同构）：只读帧头/块头定位完整帧，不解压。返回完整帧区间；末尾残缺帧
 * （写入中的尾部）被跳过，语义 = 已提交前缀。
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break // 非 zstd 内容，不再前进
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) break // 保留位
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) break // 保留块类型：视作帧结束
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 解压完整帧拼接为 JSONL 文本；非 zstd 内容原样返回。 */
function decodeLogBytes(buffer) {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) {
    if (typeof zstdDecompressSync !== 'function') {
      throw new Error('当前 Node 不支持 node:zlib zstd（需 Node ≥ 22.2）')
    }
    const { frames } = scanZstdFrames(buffer)
    if (frames.length === 0) return ''
    const parts = []
    let total = 0
    for (const frame of frames) {
      const decoded = zstdDecompressSync(buffer.subarray(frame.start, frame.end))
      total += decoded.length
      if (total > MAX_DECODED_BYTES) throw new Error('会话日志解压超限')
      parts.push(decoded)
    }
    return Buffer.concat(parts).toString('utf8')
  }
  return buffer.toString('utf8')
}

/**
 * 解析一份 JSONL 文本，折叠出逐日 token 用量。
 * @returns {{ days: Map<string,[number,number,number]>, events: number, sessions: number, errors: number, durationMs: number }}
 *   days: dayKey -> [input, output, cacheRead]；durationMs: 本会话时长（末事件 - 创建）
 */
function foldLog(text) {
  const days = new Map()
  const modelCounts = new Map()
  const reasoningCounts = new Map()
  const toolCounts = new Map()
  const hourCounts = new Map()
  const weekdayCounts = new Map()
  let events = 0
  let sessions = 0
  let errors = 0
  let createdAt = 0
  let maxEventTime = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    events += 1
    let ev
    try {
      ev = JSON.parse(trimmed)
    } catch {
      errors += 1
      continue
    }
    if (!ev || typeof ev !== 'object') {
      errors += 1
      continue
    }
    if (ev.type === 'session') {
      sessions += 1
      if (typeof ev.createdAt === 'number' && ev.createdAt > 0) createdAt = ev.createdAt
      continue
    }
    if (ev.type === 'request/header') {
      // 模型 / 推理强度统计（活动洞察）
      const config = ev.data && ev.data.header && ev.data.header.config
      if (config) {
        if (typeof config.model === 'string' && config.model) {
          modelCounts.set(config.model, (modelCounts.get(config.model) || 0) + 1)
        }
        if (typeof config.reasoningEffort === 'string' && config.reasoningEffort) {
          reasoningCounts.set(config.reasoningEffort, (reasoningCounts.get(config.reasoningEffort) || 0) + 1)
        }
      }
      continue
    }
    if (ev.type === 'tool/call') {
      // 工具调用统计（活动洞察）
      const name = ev.data && typeof ev.data.name === 'string' ? ev.data.name : null
      if (name) toolCounts.set(name, (toolCounts.get(name) || 0) + 1)
      continue
    }
    if (typeof ev.time === 'number' && ev.time > maxEventTime) maxEventTime = ev.time
    if (
      ev.type === 'assistant/chunk'
      && ev.data && typeof ev.data === 'object'
      && ev.data.chunk && typeof ev.data.chunk === 'object'
      && ev.data.chunk.type === 'usage'
      && ev.data.chunk.usage && typeof ev.data.chunk.usage === 'object'
    ) {
      const usage = ev.data.chunk.usage
      const time = typeof ev.time === 'number' ? ev.time : NaN
      if (!Number.isFinite(time) || time <= 0) continue
      const input = Number(usage.inputTokens) || 0
      const output = Number(usage.outputTokens) || 0
      const cacheRead = Number(usage.cacheReadTokens) || 0
      if (input === 0 && output === 0 && cacheRead === 0) continue
      // 活跃时段 / 活跃星期统计（活动洞察；weekday 用 0-6 数字，由前端本地化）
      const d = new Date(time)
      const hour = d.getHours()
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1)
      weekdayCounts.set(d.getDay(), (weekdayCounts.get(d.getDay()) || 0) + 1)
      const key = dayKey(time)
      const row = days.get(key)
      if (row) {
        row[0] += input
        row[1] += output
        row[2] += cacheRead
      } else {
        days.set(key, [input, output, cacheRead])
      }
    }
  }
  const durationMs = createdAt > 0 && maxEventTime > createdAt ? maxEventTime - createdAt : 0
  return { days, modelCounts, reasoningCounts, toolCounts, hourCounts, weekdayCounts, events, sessions, errors, durationMs }
}

/** 取计数最大的项（平局先见者胜）；空返回 null */
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

/** 本地日期（Date）→ YYYY-MM-DD */
function dateKey(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${m}-${d}`
}

/** YYYY-MM-DD → 次日 YYYY-MM-DD（字符串迭代，天然本地时区） */
function nextDayKey(key) {
  const [y, m, d] = key.split('-').map(Number)
  const next = new Date(y, m - 1, d + 1)
  return dateKey(next)
}

/** 由逐日数组计算峰值日 / 连续天数等汇总指标。 */
function computeStats(days) {
  let peakDay = null
  for (const row of days) {
    if (!peakDay || row.a > peakDay.a) peakDay = { d: row.d, a: row.a }
  }
  let longestStreak = 0
  let currentStreak = 0
  if (days.length > 0) {
    const usage = new Set(days.map((row) => row.d))
    // 最长连续：扫首日至末日
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
    // 当前连续：从今天（或昨天，若今天尚无用量）向前数
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

export function apply(ctx, config = {}, deps = {}) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const sessionsRoot = join(dshHome, 'sessions')
  const refreshIntervalMs = (config.refreshIntervalMinutes || 5) * 60 * 1000

  // 可注入依赖（mock 测试用）
  const readFile = deps.readFileSync || readFileSync
  const statFile = deps.statSync || statSync
  const listDir = deps.readdirSync || readdirSync

  // ── 文件级缓存：identity(size:mtimeMs) → foldLog 结果 ──
  const cache = new Map() // path -> { identity, folded }
  let lastScan = null // { at, filesScanned, filesCached, events, sessions, errors, durationMs }
  let scanInFlight = null

  function collectSessionFiles() {
    const found = []
    const stack = [sessionsRoot]
    while (stack.length > 0 && found.length < MAX_SCAN_FILES) {
      const dir = stack.pop()
      let entries
      try {
        entries = listDir(dir, { withFileTypes: true })
      } catch {
        continue // 目录不存在/无权限：跳过
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.name === 'session.jsonl.zstd' || entry.name === 'session.jsonl') {
          found.push(full)
          if (found.length >= MAX_SCAN_FILES) break
        }
      }
    }
    return found
  }

  /** 读取稳定快照（写入中重试），返回 { buffer, identity }。 */
  function readStable(path) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = statFile(path)
      const buffer = readFile(path)
      const after = statFile(path)
      if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
        return { buffer, identity: `${after.size}:${after.mtimeMs}` }
      }
    }
    throw new Error('会话文件持续写入，无法稳定读取')
  }

  function scanNow(force = false) {
    if (scanInFlight) return scanInFlight
    scanInFlight = (async () => {
      const started = Date.now()
      const files = collectSessionFiles()
      let filesScanned = 0
      let events = 0
      let sessions = 0
      let errors = 0
      let badFiles = 0
      let longestSessionMs = 0
      const dayTotals = new Map()
      const modelCounts = new Map()
      const reasoningCounts = new Map()
      const toolCounts = new Map()
      const hourCounts = new Map()
      const weekdayCounts = new Map()
      const mergeCounts = (target, src) => {
        for (const [k, v] of src) target.set(k, (target.get(k) || 0) + v)
      }
      const addDay = (key, input, output, cacheRead) => {
        const row = dayTotals.get(key)
        if (row) {
          row[0] += input
          row[1] += output
          row[2] += cacheRead
        } else {
          dayTotals.set(key, [input, output, cacheRead])
        }
      }
      for (const path of files) {
        try {
          const stat = statFile(path)
          const identity = `${stat.size}:${stat.mtimeMs}`
          const hit = cache.get(path)
          if (!force && hit && hit.identity === identity) {
            // 复用缓存
            for (const [key, row] of hit.folded.days) addDay(key, row[0], row[1], row[2])
            events += hit.folded.events
            sessions += hit.folded.sessions
            errors += hit.folded.errors
            if (hit.folded.durationMs > longestSessionMs) longestSessionMs = hit.folded.durationMs
            mergeCounts(modelCounts, hit.folded.modelCounts)
            mergeCounts(reasoningCounts, hit.folded.reasoningCounts)
            mergeCounts(toolCounts, hit.folded.toolCounts)
            mergeCounts(hourCounts, hit.folded.hourCounts)
            mergeCounts(weekdayCounts, hit.folded.weekdayCounts)
            continue
          }
          const { buffer } = readStable(path)
          const text = decodeLogBytes(buffer)
          const folded = foldLog(text)
          cache.set(path, { identity, folded })
          filesScanned += 1
          for (const [key, row] of folded.days) addDay(key, row[0], row[1], row[2])
          events += folded.events
          sessions += folded.sessions
          errors += folded.errors
          if (folded.durationMs > longestSessionMs) longestSessionMs = folded.durationMs
          mergeCounts(modelCounts, folded.modelCounts)
          mergeCounts(reasoningCounts, folded.reasoningCounts)
          mergeCounts(toolCounts, folded.toolCounts)
          mergeCounts(hourCounts, folded.hourCounts)
          mergeCounts(weekdayCounts, folded.weekdayCounts)
        } catch (err) {
          badFiles += 1
        }
      }
      // 清理已消失文件
      const alive = new Set(files)
      for (const key of cache.keys()) if (!alive.has(key)) cache.delete(key)

      const days = [...dayTotals.entries()]
        .map(([d, row]) => ({ d, i: row[0], o: row[1], c: row[2], a: row[0] + row[1] + row[2] }))
        .sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0))
      let input = 0
      let output = 0
      let cacheRead = 0
      for (const row of days) {
        input += row.i
        output += row.o
        cacheRead += row.c
      }
      lastScan = {
        at: Date.now(),
        filesScanned,
        filesCached: files.length - filesScanned,
        sessions,
        events,
        errors,
        badFiles,
        durationMs: Date.now() - started,
      }
      const stats = computeStats(days)
      const activeMonths = new Set(days.map((row) => row.d.slice(0, 7))).size
      const totalAll = input + output + cacheRead
      return {
        generatedAt: Date.now(),
        source: dshHome,
        scan: { ...lastScan },
        totals: { input, output, cacheRead, all: totalAll, days: days.length },
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

  // ── 路由 ──
  const writeJson = (res, status, payload) => {
    res.writeHead(status, JSON_HEADERS)
    res.end(JSON.stringify(payload))
  }

  const statsRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-token-usage/stats',
    handler: async (_req, res) => {
      try {
        const data = await scanNow(false)
        writeJson(res, 200, { ok: true, data })
      } catch (err) {
        writeJson(res, 502, { ok: false, error: String((err && err.message) || err) })
      }
    },
  })

  const refreshRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-token-usage/refresh',
    handler: async (_req, res) => {
      try {
        const data = await scanNow(true)
        writeJson(res, 200, { ok: true, data })
      } catch (err) {
        writeJson(res, 502, { ok: false, error: String((err && err.message) || err) })
      }
    },
  })

  const statusRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-token-usage/status',
    handler: async (_req, res) => {
      writeJson(res, 200, {
        ok: true,
        data: {
          source: dshHome,
          lastScan,
          cachedFiles: cache.size,
          refreshIntervalMs,
        },
      })
    },
  })

  const disposers = [statsRoute, refreshRoute, statusRoute]

  // 定时兜底：只重扫变化中的文件（缓存命中不重解）
  const timer = ctx.setInterval(() => { void scanNow(false) }, refreshIntervalMs)
  disposers.push(timer)

  // 启动即扫（失败不阻塞插件生命周期）
  void scanNow(false).catch(() => { /* 首次扫描失败：下次请求/定时再试 */ })

  return () => disposers.forEach((dispose) => dispose())
}