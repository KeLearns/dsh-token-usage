// dsh-token-usage host 半端测试：mock ctx + 合成会话数据 + 真实会话数据
// 运行：node test/mock.test.mjs [真实DSH_HOME]
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply } from '../index.js'

let failures = 0
const assert = (cond, msg) => {
  if (cond) console.log('  PASS:', msg)
  else { failures++; console.error('  FAIL:', msg) }
}

// ── mock ctx ──
function makeCtx() {
  const routes = []
  const ctx = {
    routes,
    setInterval: () => () => {},
    webServer: {
      register: (spec) => {
        routes.push(spec)
        return () => { const i = routes.indexOf(spec); if (i >= 0) routes.splice(i, 1) }
      },
    },
  }
  return ctx
}
async function invoke(route, req) {
  let status = 0
  let body = ''
  const res = {
    writeHead: (s) => { status = s },
    end: (b) => { body = b },
  }
  await route.handler(req, res)
  return { status, body: JSON.parse(body) }
}

// ── 合成数据：两个会话（zstd + 明文 jsonl），时间固定 ──
const T1 = new Date(2026, 6, 13, 10, 0, 0).getTime() // 2026-07-13 周一
const T2 = new Date(2026, 6, 13, 11, 0, 0).getTime()
const T3 = new Date(2026, 6, 14, 9, 0, 0).getTime() // 2026-07-14
const usageEvent = (time, input, output, cache) =>
  JSON.stringify({ type: 'assistant/chunk', seq: 1, time, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cache } } } })
const header = (id, createdAt) =>
  JSON.stringify({ type: 'session', version: 0, id, createdAt, cwd: '/tmp', agentPreset: 'standard' })

const logA = [header('sess-a', T1), usageEvent(T1, 1000, 500, 200), usageEvent(T2, 2000, 300, 100)].join('\n')
const logB = [header('sess-b', T3), usageEvent(T3, 4000, 700, 50)].join('\n')

const home = mkdtempSync(join(tmpdir(), 'dsh-token-usage-test-'))
const dirA = join(home, 'sessions', 'ws-a', 'sess-a')
const dirB = join(home, 'sessions', 'ws-b', 'sess-b')
mkdirSync(dirA, { recursive: true })
mkdirSync(dirB, { recursive: true })
writeFileSync(join(dirA, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(logA, 'utf8')))
writeFileSync(join(dirB, 'session.jsonl'), logB) // 明文回退路径

const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = home
try {
  const ctx = makeCtx()
  const dispose = apply(ctx, {}, {})
  const stats = ctx.routes.find((r) => r.path === '/dsh-token-usage/stats')
  assert(!!stats, 'stats 路由已注册')
  const { status, body } = await invoke(stats, {})
  assert(status === 200, 'stats 返回 200')
  assert(body.ok === true, 'ok 字段')
  const d = body.data
  console.log('  真实聚合:', JSON.stringify(d.totals), 'days=', JSON.stringify(d.days))
  assert(d.totals.input === 7000 && d.totals.output === 1500 && d.totals.cacheRead === 350, '总量 = 输入7000/输出1500/缓存350')
  assert(d.totals.all === 8850, '总用量 8850')
  assert(d.days.length === 2, '两个自然日')
  assert(d.days[0].d === '2026-07-13' && d.days[0].a === 4100, '7-13 合计 4100')
  assert(d.days[1].d === '2026-07-14' && d.days[1].a === 4750, '7-14 合计 4750')
  assert(d.scan.sessions === 2, '扫描到 2 个会话')
  assert(typeof d.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.today), 'today 格式')
  assert(d.stats.peakDay.d === '2026-07-14' && d.stats.peakDay.a === 4750, '峰值日 = 7-14 (4750)')
  assert(d.stats.longestSessionMs === 3600000, '最长会话时长 = 1 小时（T1→T2）')
  assert(d.stats.longestStreak === 2, '最长连续天数 = 2')
  assert(d.stats.activeDays === 2, '活跃天数 = 2')
  // 缓存命中路径
  const { body: body2 } = await invoke(stats, {})
  assert(body2.data.scan.filesCached === 2, '二次扫描全部缓存命中')
  // 强制刷新
  const refresh = ctx.routes.find((r) => r.path === '/dsh-token-usage/refresh')
  const { body: body3 } = await invoke(refresh, {})
  assert(body3.data.scan.filesScanned === 2, '强制刷新重扫 2 个文件')
  dispose()
} finally {
  process.env.DSH_HOME = oldHome
  rmSync(home, { recursive: true, force: true })
}

// ── 真实数据（可选参数指定 DSH_HOME）──
const realHome = process.argv[2]
if (realHome) {
  console.log('\n=== 真实数据扫描:', realHome, '===')
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = realHome
  try {
    const ctx = makeCtx()
    const dispose = apply(ctx, {}, {})
    const stats = ctx.routes.find((r) => r.path === '/dsh-token-usage/stats')
    const t0 = Date.now()
    const { status, body } = await invoke(stats, {})
    const d = body.data
    console.log('状态:', status, '耗时:', Date.now() - t0, 'ms')
    console.log('scan:', JSON.stringify(d.scan))
    console.log('totals:', JSON.stringify(d.totals))
    console.log('days:', d.days.length, '第一条:', JSON.stringify(d.days[0]), '最后一条:', JSON.stringify(d.days[d.days.length - 1]))
    console.log('近 7 天:', JSON.stringify(d.days.slice(-7)))
    assert(status === 200 && d.ok !== false, '真实数据 stats 可读')
    assert(d.totals.all > 0, '真实累计用量 > 0')
    dispose()
  } finally {
    process.env.DSH_HOME = old
  }
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
