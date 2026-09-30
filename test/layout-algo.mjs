// 排布算法验证：weekly 整列同色 / cum 从左到右逐格增多、右列满格
const DAY_MS = 86400000
const dow = (d) => (d.getDay() + 6) % 7
const toKey = (d) => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
// 合成数据：8 周，每天用量 = 基准 + 周一高/周末低波动（模拟真实分布）
const today = new Date(2026, 7, 14)
const byDay = new Map()
let daily = 80000
for (let i = 0; i < 56; i++) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (55 - i))
  const w = dow(d)
  const base = w === 0 || w === 6 ? 30000 : 90000 // 周末少用
  byDay.set(toKey(d), { a: base + (i * 137) % 20000 })
}
// 窗口 = 8 周
const start = new Date(today.getTime() - 55 * DAY_MS)
const weeks = 8
const levelOf = (v, max) => (v <= 0 ? 0 : Math.min(5, Math.ceil((5 * v) / max)))
// 取值函数（与 client 一致）
const dayVal = (d) => { const r = byDay.get(toKey(d)); return r ? r.a : 0 }
const weekVal = (d) => {
  const monday = new Date(d.getTime() - dow(d) * DAY_MS)
  let s = 0
  for (let i = 0; i < 7; i++) { const r = byDay.get(toKey(new Date(monday.getTime() + i * DAY_MS))); if (r) s += r.a }
  return s
}
const cumAll = (d) => { const k = toKey(d); let s = 0; for (const [kk, r] of byDay) if (kk <= k) s += r.a; return s }
// 未来格：weekly → 周总量；cum → 截至今天累计
const futureVal = (d, tab) => (tab === 'weekly' ? weekVal(d) : cumAll(d))
function render(tab) {
  // max（非未来天）
  let max = 0
  for (let c = 0; c < weeks; c++) for (let r = 0; r < 7; r++) {
    const d = new Date(start.getTime() + (c * 7 + r) * DAY_MS)
    if (d > today) continue
    const v = tab === 'weekly' ? weekVal(d) : tab === 'cum' ? cumAll(d) : dayVal(d)
    if (v > max) max = v
  }
  console.log('[' + tab + '] max=' + max.toLocaleString('en-US'))
  const out = []
  for (let r = 0; r < 7; r++) {
    let line = '  '
    for (let c = 0; c < weeks; c++) {
      const d = new Date(start.getTime() + (c * 7 + r) * DAY_MS)
      const future = d > today
      const v = future ? futureVal(d, tab) : (tab === 'weekly' ? weekVal(d) : cumAll(d))
      const lv = future && tab === 'daily' ? -1 : levelOf(v, max)
      line += lv < 0 ? '. ' : lv + ' '
    }
    out.push(line)
  }
  console.log(out.join('\n'))
  // 每列亮格数
  const colCounts = []
  for (let c = 0; c < weeks; c++) {
    let n = 0
    for (let r = 0; r < 7; r++) {
      const d = new Date(start.getTime() + (c * 7 + r) * DAY_MS)
      const future = d > today
      const v = future ? futureVal(d, tab) : (tab === 'weekly' ? weekVal(d) : cumAll(d))
      if (levelOf(v, max) > 0) n++
    }
    colCounts.push(n)
  }
  console.log('  每列亮格数(0-7):', colCounts.join(' '))
}
render('weekly')
render('cum')
process.exit(0)