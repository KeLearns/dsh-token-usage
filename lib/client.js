/* @kelearns/dsh-token-usage — browser half（手写 bundle，无构建步骤）。
 * 契约（client-modules）：window.__ModuleLoader__.load({ id: 包名, factory: (require) => exports })
 * 槽位：设置页 settings.section（label "Token 活动" → 自动出现在设置页左侧栏导航），
 *       数据走同源 /dsh-token-usage/*。
 * UI：GitHub 风格 token 用量热力图 —— 7 行（周一~周日）× 最近 12 个月（周列），
 * 三个视图 Tab：每日 / 每周 / 累计；悬停单元格显示：
 *   每日 → "M月D日 使用了 X 个 Token"
 *   每周 → "YYYY年M月D日 当周使用了 X 个 Token"（该周结束日）
 *   累计 → "截至 YYYY年M月D日 当周累计使用 X 个 Token"（周一~当日累计）
 * 数字使用中文单位（万/亿，一位小数）。样式跟随 --dsw-alias-* token，
 * 深浅主题各一套蓝色色阶（CSS 自注入 <style data-plugin-css>）。
 */
window.__ModuleLoader__.load({
  id: '@kelearns/dsh-token-usage',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    // ── 主题色阶：light / dark ──
    const SCALES = {
      // 零值 + 5 级蓝（浅色主题：浅灰底；深色主题：暗底亮蓝，跟随 DSH 应用主题）
      light: ['#f2f4f6', '#d9ecfa', '#b9ddfa', '#96c9f8', '#78b8f4', '#60b2ff'], // 零值浅灰与白底有区分度；最深 #60b2ff 取自参考图实机取色
      dark: ['#353a40', '#14334a', '#1a5182', '#1f74b5', '#2f9fe8', '#6ec2ff'],
    }

    // ── i18n：zh/en 字典（zh 为源语言），按 documentElement.lang 选择（dsh-ssh 先例）──
    const I18N = {
      zh: {
        'title': 'Token 活动',
        'range.3': '近 3 月', 'range.6': '近 6 月', 'range.12': '近 12 月',
        'tab.daily': '每日', 'tab.weekly': '每周', 'tab.cum': '累计',
        'summary.total': '累计 Token 数', 'summary.peak': '峰值 Token 数',
        'summary.longest': '最长聊天时长', 'summary.currentStreak': '当前连续天数',
        'summary.longestStreak': '最长连续天数',
        'foot.updated': '更新于 {time}', 'foot.updating': '更新中…',
        'legend.less': '少', 'legend.more': '多',
        'insights.title': '活动洞察',
        'insight.model': '最常使用的模型', 'insight.reasoning': '最常用的推理强度',
        'insight.tool': '最常用的工具', 'insight.hour': '最活跃时段',
        'insight.avgDaily': '日均用量', 'insight.avgMonthly': '月均用量',
        'insight.weekday': '最常用的星期', 'insight.day': '最活跃的一天',
        'hour.value': '{h}时', 'day.unit': '天',
        'weekday.0': '周日', 'weekday.1': '周一', 'weekday.2': '周二', 'weekday.3': '周三',
        'weekday.4': '周四', 'weekday.5': '周五', 'weekday.6': '周六',
        'loading': '统计中…', 'empty': '暂无 Token 用量数据（尚未产生任何会话用量，或会话目录为空）',
        'error': '加载失败：{msg}',
      },
      en: {
        'title': 'Token Activity',
        'range.3': '3M', 'range.6': '6M', 'range.12': '12M',
        'tab.daily': 'Daily', 'tab.weekly': 'Weekly', 'tab.cum': 'Cumulative',
        'summary.total': 'Total Tokens', 'summary.peak': 'Peak Day',
        'summary.longest': 'Longest Session', 'summary.currentStreak': 'Current Streak',
        'summary.longestStreak': 'Longest Streak',
        'foot.updated': 'Updated {time}', 'foot.updating': 'Updating…',
        'legend.less': 'Less', 'legend.more': 'More',
        'insights.title': 'Insights',
        'insight.model': 'Most used model', 'insight.reasoning': 'Most used reasoning',
        'insight.tool': 'Most used tool', 'insight.hour': 'Peak hour',
        'insight.avgDaily': 'Daily average', 'insight.avgMonthly': 'Monthly average',
        'insight.weekday': 'Most active weekday', 'insight.day': 'Most active day',
        'hour.value': '{h}:00', 'day.unit': 'days',
        'weekday.0': 'Sunday', 'weekday.1': 'Monday', 'weekday.2': 'Tuesday', 'weekday.3': 'Wednesday',
        'weekday.4': 'Thursday', 'weekday.5': 'Friday', 'weekday.6': 'Saturday',
        'loading': 'Loading…', 'empty': 'No token usage data yet (no usage recorded, or the session directory is empty)',
        'error': 'Load failed: {msg}',
      },
    }
    /** 按当前文档语言翻译；{name} 模板插值 */
    const tt = (key, values) => {
      const lang = typeof document !== 'undefined' && document.documentElement
        ? (document.documentElement.lang || '').toLowerCase()
        : 'zh'
      const dict = lang.startsWith('en') ? I18N.en : I18N.zh
      let text = dict[key] !== undefined ? dict[key] : (I18N.zh[key] !== undefined ? I18N.zh[key] : key)
      if (values) for (const [k, v] of Object.entries(values)) text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v))
      return text
    }

    /**
     * 读取 DSH 实际主题（深/浅）。DSH 主题服务把 color-scheme 写在内联 style 上，
     * 并覆写 --dsw-alias-* token；prefers-color-scheme 只反映系统主题，不可靠。
     * 判定顺序：内联 color-scheme → --dsw-alias-bg-page 亮度 → 系统媒体查询兜底。
     */
    const readDark = () => {
      try {
        const root = document.documentElement
        const inline = root.style && root.style.colorScheme
        if (inline === 'dark') return true
        if (inline === 'light') return false
        const token = getComputedStyle(root).getPropertyValue('--dsw-alias-bg-page').trim()
        if (token) {
          const nums = token.match(/[\d.]+/g)
          if (nums && nums.length >= 3) {
            return 0.299 * Number(nums[0]) + 0.587 * Number(nums[1]) + 0.114 * Number(nums[2]) < 128
          }
        }
      } catch { /* 兜底 */ }
      return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    }

    // 网格几何：固定单元格（参考图尺寸），12 个月（53 列 = 742px）超出容器时
    // 允许横向滚动，打开时自动滚到最右（最新内容）。
    const CELL = 12
    const GAP = 2
    const PITCH = CELL + GAP

    // ── 自注入样式 ──
    const PLUGIN_CSS = `
.dthm-section{display:flex;flex-direction:column;gap:12px;max-width:880px;color:var(--dsw-alias-label-primary,#1f2329)}
.dthm-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dthm-head-right{display:flex;align-items:center;gap:18px}
.dthm-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary,#1f2329)}
.dthm-range{display:flex;align-items:center;gap:12px;padding-left:14px;border-left:1px solid var(--dsw-alias-border-l2,rgba(31,35,41,.12))}
.dthm-range .dthm-tab{font-size:12px}
.dthm-summary{display:flex;align-items:stretch;border:1px solid var(--dsw-alias-border-l2,rgba(31,35,41,.08));border-radius:12px;background:var(--dsw-alias-bg-module-platform,#fff);box-shadow:0 1px 3px rgba(0,0,0,.05);overflow:hidden}
.dthm-summary-item{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;padding:14px 6px}
.dthm-summary-item + .dthm-summary-item{border-left:1px solid var(--dsw-alias-border-l2,rgba(31,35,41,.08))}
.dthm-summary-num{font-size:24px;line-height:30px;font-weight:700;color:var(--dsw-alias-label-primary,#1f2329);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.dthm-summary-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#646a73)}
.dthm-tabs{display:flex;align-items:center;gap:14px}
.dthm-tab{border:0;background:transparent;font-size:13px;line-height:22px;padding:2px 0;cursor:pointer;color:var(--dsw-alias-label-tertiary,#646a73);transition:color .15s}
.dthm-tab:hover{color:var(--dsw-alias-label-primary,#1f2329)}
.dthm-tab.active{color:var(--dsw-alias-button-primary-fill,#1a8fcf);font-weight:600}
.dthm-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#646a73);min-height:18px}
.dthm-status.err{color:var(--dsw-alias-state-danger-label,#c41f1f)}
.dthm-card{border:none;background:transparent;padding:0;overflow-x:auto}
.dthm-chart{position:relative;user-select:none}
.dthm-grid{display:inline-grid;grid-auto-flow:column;grid-template-rows:repeat(7,12px);grid-auto-columns:12px;gap:2px}
.dthm-cell{width:12px;height:12px;border-radius:4px;cursor:pointer}
.dthm-cell.future{background:transparent;cursor:default}
.dthm-cell.today{}
.dthm-months{position:relative;margin-top:4px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary,#646a73)}
.dthm-month{position:absolute;top:0;white-space:nowrap;overflow:visible}
.dthm-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:2px}
.dthm-insights{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(31,35,41,.08));display:flex;flex-direction:column;gap:8px;position:relative}
/* 中心分界线：从内容第一行开始（12 padding + 22 标题行高 + 8 gap），不碰上边框线 */
.dthm-insights::before{content:'';position:absolute;left:50%;top:42px;bottom:0;width:1px;background:var(--dsw-alias-border-l2,rgba(31,35,41,.1));pointer-events:none}
.dthm-insights-title{font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.dthm-insights-row{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px 0}
.dthm-insight-item{flex:1 1 0;min-width:0;display:flex;align-items:baseline;justify-content:flex-start;gap:8px;font-size:13.5px;line-height:20px}
/* 值右对齐：左列值贴中心分界线，右列值贴容器右缘 */
.dthm-insight-value{margin-left:auto}
/* 分界线两侧内容留出间隙，不贴线 */
.dthm-insight-item:first-child{padding-right:14px}
.dthm-insight-item:last-child{padding-left:14px}
.dthm-insight-label{color:var(--dsw-alias-label-tertiary,#646a73)}
.dthm-insight-value{color:var(--dsw-alias-label-primary,#1f2329);font-weight:600}
.dthm-legend{display:flex;align-items:center;gap:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#646a73)}
.dthm-legend .dthm-cell{width:10px;height:10px;cursor:default}
.dthm-tip{position:absolute;z-index:30;pointer-events:none;background:#2b2b2b;color:#fff;font-size:12px;line-height:18px;padding:6px 10px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.18);white-space:nowrap;max-width:340px;transform:translate(-50%,-100%)}
.dthm-btn{border:1px solid var(--dsw-alias-border-l2,rgba(31,35,41,.12));background:var(--dsw-alias-button-ghost-fill,transparent);color:var(--dsw-alias-label-primary,#1f2329);font-size:12px;line-height:20px;height:26px;padding:0 12px;border-radius:999px;cursor:pointer;transition:background .15s}
.dthm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.dthm-btn:disabled{opacity:.45;cursor:not-allowed}`
    // 版本化自愈注入：模块热重载/旧样式残留时按版本号重写，避免新旧 CSS 混用
    const CSS_VERSION = '0.1.0'
    const ensureCss = () => {
      if (typeof document === 'undefined') return
      let tag = document.querySelector('style[data-plugin-css="dsh-token-usage/styles"]')
      if (!tag) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-token-usage'
        tag.dataset.pluginCss = 'dsh-token-usage/styles'
        document.head.appendChild(tag)
      }
      if (tag.dataset.pluginVersion !== CSS_VERSION) {
        tag.textContent = PLUGIN_CSS
        tag.dataset.pluginVersion = CSS_VERSION
      }
    }
    ensureCss()

    // ── 工具函数 ──
    const h = React.createElement
    const DAY_MS = 86400000
    const pad = (n) => String(n).padStart(2, '0')

    /** YYYY-MM-DD（本地时区）→ Date（本地零点） */
    const parseDay = (key) => {
      const [y, m, d] = key.split('-').map(Number)
      return new Date(y, m - 1, d)
    }
    const toKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    /** 周一=0 … 周日=6 */
    const dow = (date) => (date.getDay() + 6) % 7

    /** 中文单位：<1万 → 千分位；<1亿 → X.X万；否则 X.X亿（一位小数） */
    const fmt = (n) => {
      if (n < 10000) return n.toLocaleString('en-US')
      if (n < 1e8) {
        const v = n / 1e4
        return (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1).replace(/\.0$/, '')) + '万'
      }
      const v = n / 1e8
      return (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1).replace(/\.0$/, '')) + '亿'
    }

    /** 时长（参考图格式，无空格）：<1 分 → X秒；<1 时 → X分；否则 X小时Y分（Y=0 省略） */
    const fmtDuration = (ms) => {
      const totalMin = Math.floor(ms / 60000)
      if (totalMin < 1) return Math.max(1, Math.round(ms / 1000)) + '秒'
      if (totalMin < 60) return totalMin + '分'
      const hours = Math.floor(totalMin / 60)
      const mins = totalMin % 60
      return mins > 0 ? hours + '小时' + mins + '分' : hours + '小时'
    }

    const fetchJson = (path, options) =>
      fetch(path, options).then(async (res) => {
        const text = await res.text()
        let data = null
        try { data = JSON.parse(text) } catch { /* 非 JSON 忽略 */ }
        if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
        return data
      })

    function HeatmapSection() {
      const [tab, setTab] = useState('daily')
      const [data, setData] = useState(null) // { days:[{d,i,o,c,a}], totals, today, generatedAt }
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [hover, setHover] = useState(null) // { key, left, top, text }
      const [dark, setDark] = useState(readDark)
      const [range, setRange] = useState(6) // 窗口：近 3/6/12 个月，默认 6（显示效果最好）
      const [lang, setLang] = useState(typeof document !== 'undefined' ? (document.documentElement.lang || 'zh') : 'zh')
      const chartRef = useRef(null)
      const cardRef = useRef(null)
      const seqRef = useRef(0)

      const load = useCallback((quiet) => {
        const seq = ++seqRef.current
        if (!quiet) setLoading(true)
        fetchJson('/dsh-token-usage/stats')
          .then((r) => {
            if (seq !== seqRef.current) return
            if (r && r.ok && r.data) setData(r.data)
            else setError((r && r.error) || '统计读取失败')
          })
          .catch((e) => {
            if (seq !== seqRef.current) return
            setError(String(e && e.message ? e.message : e))
          })
          .finally(() => {
            if (seq === seqRef.current) setLoading(false)
          })
      }, [])

      useEffect(() => { load(false) }, [load])
      // 定时 + 回到前台时静默刷新
      useEffect(() => {
        const timer = setInterval(() => load(true), 60000)
        const onVis = () => { if (document.visibilityState === 'visible') load(true) }
        document.addEventListener('visibilitychange', onVis)
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis) }
      }, [load])
      // 深浅主题跟随：DSH 主题切换会改 documentElement 的 style/class → MutationObserver；
      // 系统媒体查询作为兜底监听
      useEffect(() => {
        const apply = () => {
          setDark(readDark())
          const l = document.documentElement.lang || 'zh'
          if (l !== langRef.current) {
            langRef.current = l
            setLang(l)
          }
        }
        const langRef = { current: typeof document !== 'undefined' ? (document.documentElement.lang || 'zh') : 'zh' }
        const observer = new MutationObserver(apply)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'lang'] })
        let mq = null
        if (typeof matchMedia !== 'undefined') {
          mq = matchMedia('(prefers-color-scheme: dark)')
          mq.addEventListener('change', apply)
        }
        return () => {
          observer.disconnect()
          if (mq) mq.removeEventListener('change', apply)
        }
      }, [])

      // ── 视图模型：窗口 = 最近 range 个月（含当前周），周一为首行 ──
      const model = useMemo(() => {
        if (!data || !data.days || data.days.length === 0) return null
        const today = parseDay(data.today)
        const start = new Date(today.getFullYear(), today.getMonth() - range, today.getDate())
        while (dow(start) !== 0) start.setTime(start.getTime() - DAY_MS)
        const end = today
        const totalDays = Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1
        const weeks = Math.ceil(totalDays / 7)

        const byDay = new Map()
        for (const row of data.days) byDay.set(row.d, row)

        // 每日/每周/累计 取值函数
        const dayVal = (d) => { const r = byDay.get(toKey(d)); return r ? r.a : 0 }
        const weekVal = (d) => {
          const monday = new Date(d.getTime() - dow(d) * DAY_MS)
          let sum = 0
          for (let i = 0; i < 7; i++) {
            const r = byDay.get(toKey(new Date(monday.getTime() + i * DAY_MS)))
            if (r) sum += r.a
          }
          return sum
        }
        const cumAll = (d) => {
          const key = toKey(d)
          let sum = 0
          for (const [k, r] of byDay) if (k <= key) sum += r.a
          return sum
        }
        const weekToDate = (d) => {
          const monday = new Date(d.getTime() - dow(d) * DAY_MS)
          let sum = 0
          for (let i = 0; i <= dow(d); i++) {
            const r = byDay.get(toKey(new Date(monday.getTime() + i * DAY_MS)))
            if (r) sum += r.a
          }
          return sum
        }

        // 各 tab 的单元格数值与最大值（取色用）
        const valueOf = (d) => {
          if (tab === 'daily') return dayVal(d)
          if (tab === 'weekly') return weekVal(d)
          return cumAll(d)
        }
        let max = 0
        for (let col = 0; col < weeks; col++) {
          for (let row = 0; row < 7; row++) {
            const d = new Date(start.getTime() + (col * 7 + row) * DAY_MS)
            if (d.getTime() > end.getTime()) continue
            const v = valueOf(d)
            if (v > max) max = v
          }
        }
        // 排布算法（每周/累计视图）：总量 ÷ 7 = 单位量；列格数 = ceil(列值/单位量)，1~7 格
        // 每周：列值 = 该周总量，单位 = 窗口内最大周 ÷ 7（最高周满 7 格）
        // 累计：列值 = 截止该列最后一天的累计，单位 = 全历史总量 ÷ 7（最新列必满 7 格）
        let maxWeek = 0
        for (let col = 0; col < weeks; col++) {
          const wv = weekVal(new Date(start.getTime() + col * 7 * DAY_MS))
          if (wv > maxWeek) maxWeek = wv
        }
        const unitWeekly = maxWeek / 7
        const unitCum = data.totals ? data.totals.all / 7 : 0

        // 月份标签候选：每月首日所在列（渲染时按像素间距过滤，避免标签重叠）
        const months = []
        const cursor = new Date(start.getTime())
        while (cursor.getTime() <= end.getTime()) {
          const firstOfMonth = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
          if (firstOfMonth.getTime() >= start.getTime() && firstOfMonth.getTime() <= end.getTime()) {
            const col = Math.floor((firstOfMonth.getTime() - start.getTime()) / DAY_MS / 7)
            months.push({ col, label: `${firstOfMonth.getMonth() + 1}月` })
          }
          cursor.setMonth(cursor.getMonth() + 1)
        }

        return {
          start, end, weeks, today: toKey(today), byDay,
          valueOf, dayVal, weekVal, cumAll, weekToDate, max,
          maxWeek, unitWeekly, unitCum,
          months, totalDays,
        }
      }, [data, tab, range])

      // 打开/切换窗口时自动滚动到最右（最新内容）；12 个月超宽时才有滚动条
      useEffect(() => {
        const card = cardRef.current
        if (card) card.scrollLeft = card.scrollWidth
      }, [model, data])

      // ── tooltip 文案 ──
      const tipFor = (model, key) => {
        const d = parseDay(key)
        const y = d.getFullYear()
        const md = `${y}年${d.getMonth() + 1}月${d.getDate()}日`
        const short = `${d.getMonth() + 1}月${d.getDate()}日`
        if (tab === 'daily') {
          const v = model.dayVal(d)
          const date = y === model.end.getFullYear() ? short : md
          return v > 0 ? `${date} 使用了 ${fmt(v)} 个 Token` : `${date} 无 Token 使用`
        }
        if (tab === 'weekly') {
          const v = model.weekVal(d)
          return v > 0 ? `${md} 当周使用了 ${fmt(v)} 个 Token` : `${md} 当周无 Token 使用`
        }
        const v = model.weekToDate(d)
        return v > 0 ? `截至 ${md} 当周累计使用 ${fmt(v)} 个 Token` : `截至 ${md} 当周暂无累计使用`
      }

      const onCellEnter = (ev, key) => {
        if (!model) return
        const cell = ev.currentTarget
        const rect = cell.getBoundingClientRect()
        const chart = chartRef.current
        if (!chart) return
        const chartRect = chart.getBoundingClientRect()
        const left = rect.left - chartRect.left + rect.width / 2
        const top = rect.top - chartRect.top
        setHover({ key, left, top, text: tipFor(model, key) })
      }
      const onCellLeave = () => setHover(null)

      // ── 渲染 ──
      if (loading && !data) {
        return h('div', { className: 'dthm-section' },
          h('p', { className: 'dthm-title' }, tt('title')),
          h('p', { className: 'dthm-status' }, tt('loading')),
        )
      }
      if (!model) {
        return h('div', { className: 'dthm-section' },
          h('div', { className: 'dthm-head' },
            h('p', { className: 'dthm-title' }, tt('title')),
            h('div', { className: 'dthm-tabs' },
              ['daily', 'weekly', 'cum'].map((t) =>
                h('button', { key: t, className: 'dthm-tab' + (tab === t ? ' active' : ''), onClick: () => setTab(t) },
                  tt('tab.' + t))))),
          h('div', { className: 'dthm-card' },
            error
              ? h('p', { className: 'dthm-status err' }, tt('error', { msg: error }))
              : h('p', { className: 'dthm-status' }, tt('empty'))),
        )
      }

      const scale = dark ? SCALES.dark : SCALES.light
      const pitch = PITCH
      const cells = []
      const todayKey = model.today
      const max = Math.max(1, model.max)
      const levelOf = (v) => (v <= 0 ? 0 : Math.min(5, Math.ceil((5 * v) / max)))
      const cellStyle = (bg) => ({ width: CELL, height: CELL, background: bg })
      // 每周/累计视图：列内从底部（周日行=row6）向上堆叠 fillCount 格，颜色统一最深色
      // 每日视图：逐日按 level 分级取色，未来格透明
      const colFills = []
      // 无使用量的列不占格（整列零值色）；有量则 1~7 格
      const fillOf = (v, unit) => (v <= 0 ? 0 : Math.min(7, Math.ceil(v / (unit || 1))))
      if (tab === 'weekly') {
        for (let col = 0; col < model.weeks; col++) {
          const wv = model.weekVal(new Date(model.start.getTime() + col * 7 * DAY_MS))
          colFills.push(fillOf(wv, model.unitWeekly))
        }
      } else if (tab === 'cum') {
        for (let col = 0; col < model.weeks; col++) {
          const lastD = new Date(Math.min(
            model.start.getTime() + (col * 7 + 6) * DAY_MS,
            model.end.getTime(),
          ))
          colFills.push(fillOf(model.cumAll(lastD), model.unitCum))
        }
      }
      const gridStyle = {
        gridTemplateColumns: `repeat(${model.weeks}, ${CELL}px)`,
        gridTemplateRows: `repeat(7, ${CELL}px)`,
        gap: GAP + 'px',
      }
      for (let col = 0; col < model.weeks; col++) {
        for (let row = 0; row < 7; row++) {
          const d = new Date(model.start.getTime() + (col * 7 + row) * DAY_MS)
          const key = toKey(d)
          const future = d.getTime() > model.end.getTime()
          let style
          let interactive = true
          if (tab === 'daily') {
            const v = future ? 0 : model.valueOf(d)
            const level = future ? -1 : levelOf(v)
            style = level < 0 ? undefined : cellStyle(scale[level])
            interactive = level >= 0
          } else {
            // 底部堆叠：row 6=周日最先亮，向上 row >= 7-fill 亮；统一最深色
            const fill = colFills[col]
            const lit = row >= 7 - fill
            style = lit ? cellStyle(scale[5]) : cellStyle(scale[0])
            if (future && !lit) {
              // 未来且未填到：不渲染（保持透明），不可悬停
              style = undefined
              interactive = false
            }
          }
          const cls = 'dthm-cell' + (key === todayKey ? ' today' : '')
          cells.push(
            h('div', {
              key,
              className: cls,
              style,
              onMouseEnter: interactive ? (ev) => onCellEnter(ev, key) : undefined,
              onMouseLeave: interactive ? onCellLeave : undefined,
            }),
          )
        }
      }

      // 月份标签：全部关键定位用 inline style（不依赖注入 CSS，避免旧样式残留
      // 导致标签按文档流左排粘连）；绝对定位到各自月份首列（left = col × pitch），
      // 容器宽度 = weeks × pitch 与网格严格一致；按像素间距过滤避免窄列距下挤成一片
      const MIN_MONTH_GAP_PX = 44
      const monthCells = []
      let lastMonthCol = -100
      for (const m of model.months) {
        if ((m.col - lastMonthCol) * pitch < MIN_MONTH_GAP_PX) continue
        monthCells.push(h('span', {
          key: m.label + m.col,
          className: 'dthm-month',
          style: { position: 'absolute', top: 0, left: m.col * pitch, whiteSpace: 'nowrap' },
        }, m.label))
        lastMonthCol = m.col
      }

      const updatedAt = data && data.generatedAt
        ? new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })
        : ''

      const stats = data && data.stats
      // 活动洞察辅助：单列（标签 + 数值，左对齐）
      const insightItem = (label, value) =>
        h('div', { className: 'dthm-insight-item' },
          h('span', { className: 'dthm-insight-label' }, label),
          h('span', { className: 'dthm-insight-value' }, value))
      // 最活跃的一天（单日峰值日期；当年省略年份）
      let peakDayText = '—'
      if (data && stats && stats.peakDay) {
        const pd = parseDay(stats.peakDay.d)
        const sameYear = pd.getFullYear() === parseDay(data.today).getFullYear()
        peakDayText = (sameYear ? '' : pd.getFullYear() + '年') + (pd.getMonth() + 1) + '月' + pd.getDate() + '日'
      }
      // 活动洞察排布：按 label 字数从少到多排序，每 2 项一行（2 列等宽）
      const insightRows = (() => {
        const ins = data && data.insights
        if (!ins) return []
        const items = [
          { label: tt('insight.model'), value: (ins.topModel && ins.topModel.name) || '—' },
          { label: tt('insight.reasoning'), value: (ins.topReasoning && ins.topReasoning.name) || '—' },
          { label: tt('insight.tool'), value: (ins.topTool && ins.topTool.name) || '—' },
          { label: tt('insight.hour'), value: (ins.peakHour && ins.peakHour.name !== undefined ? tt('hour.value', { h: ins.peakHour.name }) : '—') },
          { label: tt('insight.avgDaily'), value: ins.avgDaily ? fmt(ins.avgDaily) : '—' },
          { label: tt('insight.avgMonthly'), value: ins.avgMonthly ? fmt(ins.avgMonthly) : '—' },
          { label: tt('insight.weekday'), value: (ins.topWeekday && ins.topWeekday.name !== undefined ? tt('weekday.' + ins.topWeekday.name) : '—') },
          { label: tt('insight.day'), value: peakDayText },
        ]
        // 字数升序；同字数按 label 字典序（稳定、可预期）
        items.sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label, 'zh-CN'))
        const rows = []
        for (let i = 0; i < items.length; i += 2) {
          rows.push(h('div', { className: 'dthm-insights-row' },
            insightItem(items[i].label, items[i].value),
            items[i + 1] ? insightItem(items[i + 1].label, items[i + 1].value) : null))
        }
        return rows
      })()
      const summaryCards = [
        { label: tt('summary.total'), value: data ? fmt(data.totals.all) : '…' },
        { label: tt('summary.peak'), value: stats && stats.peakDay ? fmt(stats.peakDay.a) : '—' },
        { label: tt('summary.longest'), value: stats && stats.longestSessionMs ? fmtDuration(stats.longestSessionMs) : '—' },
        { label: tt('summary.currentStreak'), value: stats ? stats.currentStreak + ' ' + tt('day.unit') : '—' },
        { label: tt('summary.longestStreak'), value: stats ? stats.longestStreak + ' ' + tt('day.unit') : '—' },
      ]

      // 数值字号按 5 张卡中最长文本统一缩放（全部一致，避免单卡缩字号不协调）：
      // 短值 24px，长值（如 19小时18分）整体降一档，保证不超出气泡宽度
      const longest = Math.max(...summaryCards.map((c) => c.value.length))
      const numFontSize = longest <= 4 ? 24 : longest <= 6 ? 19 : 16

      return h('div', { className: 'dthm-section' },
        h('div', { className: 'dthm-summary' },
          summaryCards.map((c) =>
            h('div', { key: c.label, className: 'dthm-summary-item' },
              h('span', { className: 'dthm-summary-num', style: { fontSize: numFontSize } }, c.value),
              h('span', { className: 'dthm-summary-label' }, c.label)))),
        h('div', { className: 'dthm-head' },
          h('p', { className: 'dthm-title' }, tt('title')),
          h('div', { className: 'dthm-head-right' },
            h('div', { className: 'dthm-range' },
              [3, 6, 12].map((m) =>
                h('button', {
                  key: m,
                  className: 'dthm-tab' + (range === m ? ' active' : ''),
                  onClick: () => setRange(m),
                }, tt('range.' + m)))),
            h('div', { className: 'dthm-tabs' },
              ['daily', 'weekly', 'cum'].map((t) =>
                h('button', {
                  key: t,
                  className: 'dthm-tab' + (tab === t ? ' active' : ''),
                  onClick: () => setTab(t),
                }, tt('tab.' + t)))))),
        h('div', { className: 'dthm-card', ref: cardRef },
          h('div', { className: 'dthm-chart', ref: chartRef },
            h('div', { className: 'dthm-grid', style: gridStyle }, cells),
            h('div', {
              className: 'dthm-months',
              style: { position: 'relative', marginTop: 4, fontSize: 10, lineHeight: '15px', width: model.weeks * pitch, height: 16 },
            }, monthCells),
            hover
              ? h('div', {
                  className: 'dthm-tip',
                  style: {
                    left: Math.max(90, Math.min(hover.left, (chartRef.current ? chartRef.current.clientWidth : 600) - 110)),
                    top: Math.max(20, hover.top - 4),
                  },
                }, hover.text)
              : null)),
        // 更新时间 + 颜色图例：独立成行，位于热力图矩阵下方（不内联在卡片内）
        h('div', { className: 'dthm-foot' },
          h('span', { className: 'dthm-status' },
            loading ? tt('foot.updating') : (updatedAt ? tt('foot.updated', { time: updatedAt }) : '')),
          tab === 'daily'
            ? h('span', { className: 'dthm-legend' },
                h('span', null, tt('legend.less')),
                scale.map((c, i) => h('span', { key: i, className: 'dthm-cell', style: { background: c } })),
                h('span', null, tt('legend.more')))
            : null),
        data && data.insights
          ? h('div', { className: 'dthm-insights' },
              h('div', { className: 'dthm-insights-title' }, tt('insights.title')),
              insightRows)
          : null,
      )
    }

    const name = 'dsh-token-usage'
    const inject = ['slots']

    // ── 设置侧边栏图标 ──
    // DSH 设置壳 navIcon(id) 按 section id 硬编码图标，未知 id 一律渲染齿轮；
    // settings.section 槽位不传 icon，因此做纯视觉 DOM 微替换：把导航行里
    // 的齿轮 SVG 换成 DSH 图标库的 ic_ds_data_outline_16（数据柱状，16px）。
    // MutationObserver + rAF 合并自愈（设置面板打开/关闭会重建 DOM）。
    const NAV_ICON_PATHS =
      '<path fill-rule="evenodd" clip-rule="evenodd" d="M12.0997 8.54554C12.2905 8.54989 12.3541 8.58056 12.4535 8.74614L12.8849 9.46387C12.9851 9.63071 13.0464 9.66013 13.2388 9.66447H14.1138C14.3417 9.66448 14.3512 9.66937 14.4686 9.86507L14.892 10.5717C14.9942 10.7422 14.9948 10.8247 14.892 10.9961L14.4756 11.6906C14.3741 11.8677 14.3694 11.9379 14.4756 12.115L14.892 12.8096C14.9942 12.9801 14.9947 13.0625 14.892 13.234L14.4686 13.9406C14.3643 14.1028 14.3063 14.1354 14.1138 14.1412H13.2388C13.0465 14.1456 12.985 14.1752 12.8849 14.3418L12.4535 15.0595C12.353 15.2195 12.2895 15.2558 12.0997 15.2601H11.2237C10.9962 15.2601 10.9871 15.2548 10.8699 15.0595L10.4384 14.3418C10.3383 14.175 10.2767 14.1456 10.0846 14.1412H9.2096C9.01854 14.1355 8.95761 14.1006 8.85477 13.9406L8.43139 13.234C8.32562 13.0576 8.33148 12.9862 8.43139 12.8096L8.84771 12.115C8.95165 11.9416 8.94659 11.863 8.84771 11.6906L8.43139 10.9961C8.32767 10.8232 8.33411 10.7437 8.43139 10.5717L8.85477 9.86507C8.95447 9.69891 9.01875 9.67017 9.2096 9.66447H10.0846C10.2741 9.66441 10.3414 9.62547 10.4384 9.46387L10.8699 8.74614C10.987 8.55106 10.9963 8.54554 11.2237 8.54554H12.0997ZM11.6612 10.232C11.3326 10.7798 10.8155 11.0948 10.1743 11.106C10.4443 11.61 10.4425 12.1976 10.1743 12.6987C10.803 12.7096 11.3391 13.0359 11.6612 13.5727C11.9855 13.0323 12.5131 12.7098 13.148 12.6987C12.879 12.196 12.8789 11.6086 13.148 11.106C12.5076 11.0948 11.9894 10.7794 11.6612 10.232Z" fill="currentColor"/>' +
      '<path fill-rule="evenodd" clip-rule="evenodd" d="M7.51205 0.790627C9.19055 0.790649 10.7401 1.0691 11.892 1.54364C12.4664 1.78029 12.9719 2.07885 13.3436 2.4408C13.7171 2.80467 13.9916 3.27253 13.9918 3.82384V7.90442C13.6067 7.69532 13.1907 7.53597 12.7529 7.43366V5.66454C12.4928 5.82898 12.2028 5.97601 11.892 6.10405C10.74 6.57865 9.19071 6.85706 7.51205 6.85706C5.8337 6.85703 4.285 6.57852 3.13309 6.10405C2.82215 5.97593 2.53164 5.8291 2.27121 5.66454V7.4135C2.27134 7.75678 2.6066 8.27106 3.62502 8.73405C4.58641 9.17097 5.95762 9.45591 7.50499 9.45681C7.24582 9.83133 7.03684 10.2434 6.88706 10.6826C5.44388 10.6162 4.12516 10.3216 3.11192 9.86104C2.81708 9.72698 2.53185 9.56866 2.27121 9.38928V11.2542C2.27158 11.5974 2.60697 12.1109 3.62502 12.5737C4.41933 12.9347 5.4937 13.1898 6.71569 13.2693C6.80349 13.7128 6.9513 14.1345 7.14814 14.5273C5.60324 14.4862 4.18593 14.1889 3.11192 13.7007C2.01039 13.1998 1.03366 12.3814 1.03333 11.2542V3.82384C1.03352 3.27273 1.30721 2.80461 1.68049 2.4408C2.05211 2.07893 2.55887 1.78026 3.13309 1.54364C4.28492 1.06926 5.83393 0.790683 7.51205 0.790627ZM7.51205 2.02851C5.95492 2.02857 4.57354 2.29079 3.60486 2.68979C3.11958 2.88977 2.76667 3.11253 2.5454 3.32788C2.32671 3.54101 2.2714 3.7089 2.27121 3.82384C2.27121 3.93882 2.32624 4.10625 2.5454 4.3198C2.76667 4.53527 3.11927 4.75781 3.60486 4.9579C4.5736 5.35699 5.95467 5.61914 7.51205 5.61918C9.06942 5.61918 10.4505 5.35695 11.4192 4.9579C11.9051 4.75773 12.2584 4.53536 12.4797 4.3198C12.6988 4.10627 12.7529 3.93882 12.7529 3.82384C12.7527 3.70889 12.6984 3.54104 12.4797 3.32788C12.2584 3.11239 11.9049 2.88989 11.4192 2.68979C10.4505 2.29079 9.06925 2.02853 7.51205 2.02851Z" fill="currentColor"/>'

    function patchNavIcon() {
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog) return
      const buttons = dialog.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.textContent.trim() !== tt('title')) continue
        const svg = btn.querySelector('svg')
        if (!svg || svg.dataset.dshTokenUsageNavicon !== undefined) continue
        const fresh = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        fresh.setAttribute('width', '16')
        fresh.setAttribute('height', '16')
        fresh.setAttribute('viewBox', '0 0 16 16')
        fresh.setAttribute('fill', 'none')
        fresh.setAttribute('aria-hidden', 'true')
        const cls = svg.getAttribute('class')
        if (cls) fresh.setAttribute('class', cls)
        fresh.dataset.dshTokenUsageNavicon = ''
        fresh.innerHTML = NAV_ICON_PATHS
        svg.replaceWith(fresh)
      }
    }

    function apply(ctx) {
      ensureCss()
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-token-usage',
        order: 85,
        label: () => tt('title'),
      }, HeatmapSection))

      // 侧边栏图标微替换（设置面板打开/重建时自愈；失败只影响图标，绝不影响 GUI）
      let scheduled = false
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(() => {
          scheduled = false
          try { patchNavIcon() } catch { /* 图标替换失败可忽略 */ }
        })
      }
      const observer = new MutationObserver(schedule)
      try {
        observer.observe(document.body, { childList: true, subtree: true })
        schedule()
      } catch (error) {
        console.warn('[dsh-token-usage] nav icon patch unavailable:', error)
      }

      return () => {
        observer.disconnect()
      }
    }

    return { name, inject, apply }
  },
})