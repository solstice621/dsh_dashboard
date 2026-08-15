// ===== Token 用量统计 · Client 半区（插件 toksta-5）=====
//
// 用法：本文件内容即 cordis_define 的 code.client「函数体」——整段复制粘贴即可。
// 依赖（部署前用 cordis_inspect_query 核对）：
//   - Client Builtin：React、host、styles（styles 是 Builtin！不能用 ctx.get('styles')）
//   - Client Service：timer（inject: ['timer']，组件内经模块级桥调用 ctx.interval）、
//     locale（可选：getLocale().active ∈ zh|en，跟随 DSH 语言切换中/英 UI）
//   - Client Slot：settings.section（list/root，注册 {id, order, label}）、
//     tool.view.cordis（keyed，key 只能是 'self'）
// 版本：v24（部署中；v23 = pkg-33）
// v24 变更（仅 client.js，修复「热力图颜色无区分」）：
//   色阶改为对数+线性混合 6 档（新增 lv5 深砖红 #a83a12）：单一大峰值日时对数刻度
//   会把多数活跃日压进同一档（如 1.95亿 与 4,856万 都是 lv4）；混合线性分量后
//   大值拉开梯度（1.95亿→lv5、4,856万→lv4、百万→lv3、十万以下→lv2、微量→lv1）
// （v21 起：扫描期不显示部分数字 + 2s/30s 自适应轮询；v19 起 i18n 双语；
//  v20 修复英文残留；v22/v23 host v6 修复活跃会话丢失）

function h() { return React.createElement.apply(null, arguments) }
function pad2(n) { return n < 10 ? '0' + n : '' + n }
function dayKeyOf(time) {
  const d = new Date(time)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

// ---- i18n ----
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DICT = {
  zh: {
    title: '统计',
    subtitle: '共 {s} 个会话 · {r} 次请求 · {d} 个活跃日',
    scanning: '正在扫描历史会话（{done}/{total}）…',
    loading: '加载中…',
    loadFailed: '加载失败：',
    cardTotal: '累计 Token 数',
    cardPeak: '峰值 Token 数',
    peakSub: '{date} · 单次峰值 {t}',
    cardChat: '最长聊天时长',
    turnSub: '最长单轮 {t}',
    cardCur: '当前连续天数',
    cardLong: '最长连续天数',
    activity: 'Token 活动',
    tabDaily: '每日',
    tabWeekly: '每周',
    consumed: '{date}消耗了 {t} Token · {n} 次请求',
    none: '{date}没有 Token 消耗',
    weekConsumed: '{start} ~ {end} 所在周消耗了 {t} Token',
    runTotal: '累计 {t} · 今日连续 {n} 天 · 峰值日 {p}',
    runHint: '完整图表见「设置 → 统计」',
    insight: '洞察',
    insTurns: '聊天总数',
    insReqs: 'LLM 请求数',
    insSessions: '会话总数',
    insDays: '活跃天数',
    insHit: '缓存命中率',
    insAvgT: '平均每轮 Token',
    insAvgD: '平均每轮时长',
    valTurns: '{n} 轮',
    valReqs: '{n} 次',
    valSessions: '{n} 个',
    valDays: '{n} 天',
    valHit: '{n} %',
    favModels: '最喜欢的模型',
    noModels: '暂无模型数据',
  },
  en: {
    title: 'Stats',
    subtitle: '{s} sessions · {r} requests · {d} active days',
    scanning: 'Scanning history ({done}/{total})…',
    loading: 'Loading…',
    loadFailed: 'Failed to load: ',
    cardTotal: 'Total tokens',
    cardPeak: 'Peak tokens',
    peakSub: '{date} · single-call peak {t}',
    cardChat: 'Longest chat',
    turnSub: 'longest turn {t}',
    cardCur: 'Current streak',
    cardLong: 'Longest streak',
    activity: 'Token activity',
    tabDaily: 'Daily',
    tabWeekly: 'Weekly',
    consumed: '{date}: {t} tokens · {n} requests',
    none: 'No token usage on {date}',
    weekConsumed: '{start} ~ {end}: {t} tokens this week',
    runTotal: 'Total {t} · {n}-day streak · peak day {p}',
    runHint: 'Full dashboard: Settings → Stats',
    insight: 'Insights',
    insTurns: 'Total turns',
    insReqs: 'LLM requests',
    insSessions: 'Sessions',
    insDays: 'Active days',
    insHit: 'Cache hit rate',
    insAvgT: 'Avg tokens / turn',
    insAvgD: 'Avg turn duration',
    valTurns: '{n}',
    valReqs: '{n}',
    valSessions: '{n}',
    valDays: '{n}',
    valHit: '{n}%',
    favModels: 'Favorite models',
    noModels: 'No model data',
  },
}
let activeLang = 'zh'
const i18nListeners = new Set()
function t(key) {
  const d = DICT[activeLang] || DICT.en
  return key in d ? d[key] : key
}
function tf(key, vars) {
  let s = t(key)
  if (vars) {
    for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]))
  }
  return s
}
// 语言切换时强制重渲染（Dashboard/RunCard 调用）
function useT() {
  const st = React.useState(0)
  React.useEffect(() => {
    const fn = () => st[1]((v) => v + 1)
    i18nListeners.add(fn)
    return () => i18nListeners.delete(fn)
  }, [])
}

function fmtTokens(n) {
  if (!n) return '0'
  const trim1 = (v) => { const s = v.toFixed(1); return s.endsWith('.0') ? s.slice(0, -2) : s }
  if (activeLang === 'en') {
    if (n >= 1e9) return trim1(n / 1e9) + 'B'
    if (n >= 1e6) return trim1(n / 1e6) + 'M'
    if (n >= 1e3) return trim1(n / 1e3) + 'k'
    return String(n)
  }
  if (n >= 1e8) return trim1(n / 1e8) + ' 亿'
  if (n >= 1e4) return trim1(n / 1e4) + ' 万'
  return String(n)
}
function fmtDuration(ms) {
  if (!ms) return activeLang === 'en' ? '0m' : '0 分钟'
  const hour = Math.floor(ms / 3600000)
  const min = Math.round((ms % 3600000) / 60000)
  if (activeLang === 'en') {
    if (hour > 0) return hour + 'h ' + min + 'm'
    if (min > 0) return min + 'm'
    return Math.floor(ms / 1000) + 's'
  }
  if (hour > 0) return hour + ' 小时 ' + min + ' 分'
  if (min > 0) return min + ' 分钟'
  return Math.floor(ms / 1000) + ' 秒'
}
function cellLevel(v, max) {
  if (!v || max <= 0) return 0
  // 对数+线性混合 6 档：对数为主（偏斜数据）、线性为辅（大值拉开梯度），
  // 避免单一大峰值日把多数活跃日压进同一档（修复「热力图颜色无区分」）
  const lr = Math.log(v + 1) / Math.log(max + 1)
  const rr = v / max
  const r = 0.55 * lr + 0.45 * rr
  if (r >= 0.85) return 5
  if (r >= 0.6) return 4
  if (r >= 0.38) return 3
  if (r >= 0.18) return 2
  return 1
}
// 日期头部：「2026年8月15日」/「Aug 15, 2026」
function dateHead(date) {
  const y = parseInt(date.slice(0, 4), 10)
  const m = parseInt(date.slice(5, 7), 10)
  const d = parseInt(date.slice(8, 10), 10)
  if (activeLang === 'en') return MONTHS_EN[m - 1] + ' ' + d + ', ' + y
  return y + '年' + m + '月' + d + '日'
}
// 悬停提示：「2026年8月15日消耗了 27.3 万 Token · 34 次请求」
function tipText(cell) {
  const head = dateHead(cell.date)
  return cell.total > 0
    ? tf('consumed', { date: head, t: fmtTokens(cell.total), n: cell.requests })
    : tf('none', { date: head })
}
// 每周悬停提示
function weekTipText(start, end, total) {
  return tf('weekConsumed', {
    start: dateHead(start), end: dateHead(end), t: fmtTokens(total),
  })
}
// 网格列数：53 列 ≈ 一年，最后一列以今天结尾，今天恒在最右下角
const GRID_COLUMNS = 53
function buildGrid(days, colCount) {
  const map = new Map()
  for (const d of days) map.set(d.date, d)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const weeks = []
  let max = 0
  for (let k = 0; k < colCount; k += 1) {
    const colEnd = new Date(today)
    colEnd.setDate(colEnd.getDate() - 7 * (colCount - 1 - k))
    const week = []
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(colEnd)
      d.setDate(d.getDate() - i)
      const key = dayKeyOf(d.getTime())
      const day = map.get(key)
      const total = day ? day.total : 0
      if (total > max) max = total
      week.push({ date: key, total: total, requests: day ? day.requests : 0 })
    }
    weeks.push(week)
  }
  // 月份标签：锚定「包含该月 1 日」的那一列；网格起点落在月中间时该月不标记
  const monthLabels = []
  const firstDay = new Date(weeks[0][0].date + 'T00:00:00')
  firstDay.setDate(firstDay.getDate() - 1)
  let lastLabelMonth = firstDay.getFullYear() * 12 + firstDay.getMonth()
  for (const w of weeks) {
    const f = new Date(w[0].date + 'T00:00:00')
    const l = new Date(w[6].date + 'T00:00:00')
    const mFirst = f.getFullYear() * 12 + f.getMonth()
    const mLast = l.getFullYear() * 12 + l.getMonth()
    let label = ''
    for (let m = mFirst; m <= mLast; m += 1) {
      if (m > lastLabelMonth) {
        lastLabelMonth = m
        if (label === '') {
          label = activeLang === 'en' ? MONTHS_EN[m % 12] : ((m % 12) + 1) + '月'
        }
      }
    }
    monthLabels.push(label)
  }
  return { weeks: weeks, monthLabels: monthLabels, max: max }
}

// 定时器桥：apply 中捕获 ctx.interval 后注入（组件内无法直接访问 ctx）
let intervalRef = null
function startInterval(callback, delay) {
  return intervalRef ? intervalRef(callback, delay) : null
}

// 自适应单行数值：测得溢出时按比例缩小字号（22px 起，最低 12px）
function FitValue(props) {
  const ref = React.useRef(null)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const fit = () => {
      el.style.fontSize = '22px'
      const avail = el.clientWidth
      const need = el.scrollWidth
      if (need > avail && need > 0) {
        el.style.fontSize = Math.max(12, Math.floor(22 * avail / need)) + 'px'
      }
    }
    fit()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(fit)
      ro.observe(el)
      return () => ro.disconnect()
    }
    return undefined
  }, [props.text])
  return h('div', { ref: ref, className: 'tks-card-value' }, props.text)
}

function StatCard(props) {
  return h('div', { className: 'tks-card' },
    h(FitValue, { text: props.value }),
    h('div', { className: 'tks-card-label' }, props.label),
    props.sub ? h('div', { className: 'tks-card-sub' }, props.sub) : null)
}

function Heatmap(props) {
  const wrapRef = React.useRef(null)
  const g = buildGrid(props.days, GRID_COLUMNS)
  // 宽度自适应：按容器宽度计算格子尺寸（--tks-size，4~16px）
  React.useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const fit = () => {
      const avail = el.clientWidth
      const size = Math.max(4, Math.min(16,
        Math.floor((avail - 4 - (GRID_COLUMNS - 1) * 1) / GRID_COLUMNS)))
      el.style.setProperty('--tks-size', size + 'px')
    }
    fit()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(fit)
      ro.observe(el)
      return () => ro.disconnect()
    }
    return undefined
  }, [])
  const colCount = g.weeks.length
  const columns = g.weeks.map((week, wi) =>
    h('div', { key: wi, className: 'tks-col' },
      week.map((c, ci) => {
        let edge = ''
        if (wi < 8) edge = ' tks-tip-left'
        else if (wi >= colCount - 2) edge = ' tks-tip-right'
        return h('div', {
          key: ci,
          className: 'tks-cell tks-lv' + cellLevel(c.total, g.max) + edge,
        }, h('span', { className: 'tks-tip' }, tipText(c)))
      })))
  // 每周柱状：每列 = 一周用量，7 格自下而上填充；最大周全满，其余按比例整数格
  const weekTotals = []
  let maxWeek = 0
  for (const w of g.weeks) {
    let t = 0
    for (const c of w) t += c.total
    weekTotals.push(t)
    if (t > maxWeek) maxWeek = t
  }
  const filledCount = weekTotals.map((t) =>
    t <= 0 ? 0 : Math.max(1, Math.min(7, Math.round(7 * t / maxWeek))))
  const weeklyCols = g.weeks.map((w, wi) => {
    let edge = ''
    if (wi < 8) edge = ' tks-tip-left'
    else if (wi >= colCount - 2) edge = ' tks-tip-right'
    const tip = weekTipText(w[0].date, w[6].date, weekTotals[wi])
    return h('div', { key: wi, className: 'tks-col' },
      w.map((c, ci) => {
        const full = ci >= 7 - filledCount[wi]
        return h('div', {
          key: ci,
          className: 'tks-cell' + (full ? ' tks-week-full' : ' tks-lv0') + edge,
        }, h('span', { className: 'tks-tip' }, tip))
      }))
  })
  return h('div', { ref: wrapRef, className: 'tks-heatmap-wrap' },
    props.view === 'weekly'
      ? h('div', { className: 'tks-weekly' }, weeklyCols)
      : h('div', { className: 'tks-heatmap' }, columns),
    h('div', { className: 'tks-months' },
      g.monthLabels.map((m, i) => h('span', { key: i }, m))))
}

// 洞察：一组有趣的小数据
function Insights(props) {
  const d = props.data
  const hit = d.totalTokens > 0 ? Math.round(100 * d.totalCacheRead / d.totalTokens) : 0
  const perTurnTokens = d.totalTurns > 0 ? fmtTokens(Math.round(d.totalTokens / d.totalTurns)) : '0'
  const perTurnMs = d.totalTurns > 0 ? Math.round(d.totalChatMs / d.totalTurns) : 0
  const rows = [
    [t('insTurns'), tf('valTurns', { n: d.totalTurns })],
    [t('insReqs'), tf('valReqs', { n: d.totalRequests })],
    [t('insSessions'), tf('valSessions', { n: d.totalSessions })],
    [t('insDays'), tf('valDays', { n: d.activeDays })],
    [t('insHit'), tf('valHit', { n: hit })],
    [t('insAvgT'), perTurnTokens],
    [t('insAvgD'), fmtDuration(perTurnMs)],
  ]
  return h('div', { className: 'tks-insight-panel' },
    h('div', { className: 'tks-insight-title' }, t('insight')),
    h('div', { className: 'tks-insight-list' },
      rows.map((r, i) => h('div', { key: i, className: 'tks-insight-row' },
        h('span', { className: 'tks-insight-label' }, r[0]),
        h('span', { className: 'tks-insight-value' }, r[1])))))
}

// 最喜欢的模型：provider/model 的 token 用量排名（Top5 + 比例条）
function ModelRanking(props) {
  const models = (props.data.models || []).slice(0, 5)
  const max = models.length ? models[0].tokens : 0
  return h('div', { className: 'tks-insight-panel' },
    h('div', { className: 'tks-insight-title' }, t('favModels')),
    models.length === 0
      ? h('div', { className: 'tks-insight-empty' }, t('noModels'))
      : h('div', { className: 'tks-model-list' },
        models.map((m, i) => h('div', { key: m.key, className: 'tks-model-row' },
          h('div', { className: 'tks-model-top' },
            h('span', { className: 'tks-model-name' }, (i + 1) + '. ' + m.key),
            h('span', { className: 'tks-model-val' }, fmtTokens(m.tokens))),
          h('div', { className: 'tks-model-bar-wrap' },
            h('div', {
              className: 'tks-model-bar',
              style: { width: (max > 0 ? Math.max(2, Math.round(100 * m.tokens / max)) : 0) + '%' },
            }))))))
}

function Dashboard(props) {
  useT() // 语言切换时重渲染
  const st = React.useState(null)
  const data = st[0]; const setData = st[1]
  const errSt = React.useState(null)
  const error = errSt[0]; const setError = errSt[1]
  const viewSt = React.useState('daily')
  const view = viewSt[0]; const setView = viewSt[1]
  const load = function () {
    host.call('get-stats').then(setData, (e) => setError(String(e)))
  }
  React.useEffect(() => {
    load()
    // 扫描期间 2s 轮询，就绪后 30s
    const delay = data && data.scanning ? 2000 : 30000
    const t = startInterval(load, delay)
    return t || undefined
  }, [data ? data.scanning : false])
  if (error) return h('div', { className: 'tks-root' }, t('loadFailed'), error)
  if (!data) return h('div', { className: 'tks-root' }, t('loading'))
  // 扫描期不显示部分数字（避免升级/重启后累计数跳变），显示进度占位
  if (data.scanning && !data.ready) {
    return h('div', { className: 'tks-root' },
      h('div', { className: 'tks-title' }, t('title')),
      h('div', { className: 'tks-subtitle' },
        tf('scanning', { done: data.scannedSessions, total: data.totalSessions })))
  }
  return h('div', { className: 'tks-root' },
    h('div', { className: 'tks-header' },
      h('div', null,
        h('div', { className: 'tks-title' }, t('title')),
        h('div', { className: 'tks-subtitle' },
          data.scanning
            ? tf('scanning', { done: data.scannedSessions, total: data.totalSessions })
            : tf('subtitle', { s: data.totalSessions, r: data.totalRequests, d: data.activeDays })))),
    h('div', { className: 'tks-cards' },
      h(StatCard, { value: fmtTokens(data.totalTokens), label: t('cardTotal') }),
      h(StatCard, {
        value: data.peakDay ? fmtTokens(data.peakDay.total) : '0',
        label: t('cardPeak'),
        sub: data.peakDay ? tf('peakSub', { date: data.peakDay.date, t: fmtTokens(data.peakStepTokens) }) : null,
      }),
      h(StatCard, {
        value: fmtDuration(data.longestChatMs),
        label: t('cardChat'),
        sub: tf('turnSub', { t: fmtDuration(data.longestTurnMs) }),
      }),
      h(StatCard, { value: tf('valDays', { n: data.streakCurrent }), label: t('cardCur') }),
      h(StatCard, { value: tf('valDays', { n: data.streakLongest }), label: t('cardLong') })),
    h('div', { className: 'tks-activity' },
      h('div', { className: 'tks-activity-head' },
        h('span', { className: 'tks-activity-title' }, t('activity')),
        h('div', { className: 'tks-tabs' },
          h('button', {
            className: 'tks-tab' + (view === 'daily' ? ' active' : ''),
            onClick: () => setView('daily'),
          }, t('tabDaily')),
          h('button', {
            className: 'tks-tab' + (view === 'weekly' ? ' active' : ''),
            onClick: () => setView('weekly'),
          }, t('tabWeekly')))),
      h(Heatmap, { days: data.days, view: view }),
      h('div', { className: 'tks-insights-row' },
        h(Insights, { data: data }),
        h(ModelRanking, { data: data }))))
}

function RunCard() {
  useT() // 语言切换时重渲染
  const st = React.useState(null)
  const data = st[0]; const setData = st[1]
  const load = function () {
    host.call('get-stats').then(setData, () => {})
  }
  React.useEffect(() => {
    load()
    const delay = data && data.scanning ? 2000 : 30000
    const t = startInterval(load, delay)
    return t || undefined
  }, [data ? data.scanning : false])
  if (!data || (data.scanning && !data.ready)) return h('div', null, t('loading'))
  return h('div', { className: 'tks-runcard' },
    h('b', null, activeLang === 'en' ? t('title') + ': ' : t('title') + '：'),
    tf('runTotal', {
      t: fmtTokens(data.totalTokens),
      n: data.streakCurrent,
      p: data.peakDay ? fmtTokens(data.peakDay.total) : '0',
    }),
    h('div', { className: 'tks-card-sub' }, t('runHint')))
}

const CSS = [
  '.tks-root{padding:8px 4px;max-width:960px}',
  '.tks-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}',
  '.tks-title{font-size:20px;font-weight:600}',
  '.tks-subtitle{font-size:12px;opacity:.6;margin-top:4px}',
  '.tks-cards{display:flex;border:1px solid rgba(128,128,128,.25);border-radius:10px;overflow:hidden;margin-bottom:24px}',
  '.tks-card{flex:1;display:flex;flex-direction:column;align-items:center;padding:16px 8px 12px;text-align:center;min-width:0}',
  '.tks-card+.tks-card{border-left:1px solid rgba(128,128,128,.2)}',
  // 数值：nowrap + 定高 30px，字号由 FitValue 自适应收缩；定高保证各卡标签同一高度
  '.tks-card-value{width:100%;height:30px;line-height:30px;font-size:22px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.tks-card-label{font-size:12px;opacity:.6;margin-top:6px}',
  '.tks-card-sub{font-size:11px;opacity:.45;margin-top:4px}',
  '.tks-activity-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}',
  '.tks-activity-title{font-size:15px;font-weight:600}',
  '.tks-tabs{display:flex;gap:2px}',
  '.tks-tab{border:none;background:none;font-size:13px;padding:4px 8px;cursor:pointer;opacity:.5;color:inherit}',
  '.tks-tab.active{opacity:1;font-weight:600;border-bottom:2px solid currentColor}',
  // 顶部留白 22px 给首行方块的悬停提示（提示框已缩小）
  // overflow-x:hidden：稳态格子必然 ≤ 容器宽（fit 精确填充），不需要滚动条；
  // align-items:safe center：内容窄于容器时整体居中
  '.tks-heatmap-wrap{overflow-x:hidden;padding:22px 2px 8px;display:flex;flex-direction:column;align-items:safe center}',
  '.tks-heatmap{display:flex;gap:1px}',
  '.tks-col{display:flex;flex-direction:column;gap:1px}',
  // 格子尺寸由 Heatmap 按容器宽度计算（--tks-size），默认 12px
  '.tks-cell{width:var(--tks-size,12px);height:var(--tks-size,12px);border-radius:2px;display:inline-block;position:relative}',
  '.tks-lv0{background:rgba(128,128,128,.14)}',
  '.tks-lv1{background:#f6c9b3}',
  '.tks-lv2{background:#ef9f7d}',
  '.tks-lv3{background:#e5764c}',
  '.tks-lv4{background:#c74e24}',
  '.tks-lv5{background:#a83a12}',
  // 自定义悬停提示：纯 CSS 跟随 :hover，不依赖 window/document
  '.tks-tip{display:none;position:absolute;bottom:13px;left:50%;transform:translateX(-50%);z-index:60;background:rgba(32,32,32,.94);color:#fafafa;font-size:10px;line-height:1.45;padding:2px 6px;border-radius:4px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.18)}',
  '.tks-cell:hover .tks-tip{display:block}',
  '.tks-tip-left .tks-tip{left:-1px;transform:none}',
  '.tks-tip-right .tks-tip{left:auto;right:-1px;transform:none}',
  // overflow:hidden：nowrap 标签文字（如「10月」/「Aug」）宽过列距，防止其撑大 scrollable overflow
  '.tks-months{display:flex;gap:1px;margin-top:6px;font-size:10px;opacity:.55;overflow:hidden}',
  // span 宽 = 格子宽，pitch = 格子宽 + 1px gap，与热力网格严格同宽对齐
  '.tks-months span{width:var(--tks-size,12px);overflow:visible;white-space:nowrap}',
  // 每周视图：与热力图同构对齐（53 列，pitch 一致），自下而上填充
  '.tks-weekly{display:flex;gap:1px}',
  '.tks-week-full{background:#e5764c}',
  // 洞察 + 最喜欢的模型：平行两栏
  '.tks-insights-row{display:flex;gap:16px;margin-top:20px}',
  '.tks-insight-panel{flex:1;min-width:0;border:1px solid rgba(128,128,128,.2);border-radius:8px;padding:12px 14px}',
  '.tks-insight-title{font-size:13px;font-weight:600;margin-bottom:10px}',
  '.tks-insight-list{display:flex;flex-direction:column;gap:7px}',
  '.tks-insight-row{display:flex;justify-content:space-between;font-size:12px}',
  '.tks-insight-label{opacity:.6}',
  '.tks-insight-value{font-weight:600}',
  '.tks-insight-empty{font-size:12px;opacity:.5}',
  '.tks-model-list{display:flex;flex-direction:column;gap:10px}',
  '.tks-model-row{display:flex;flex-direction:column;gap:4px}',
  '.tks-model-top{display:flex;justify-content:space-between;font-size:12px;gap:8px}',
  '.tks-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.tks-model-val{font-weight:600;flex-shrink:0}',
  '.tks-model-bar-wrap{height:6px;border-radius:3px;background:rgba(128,128,128,.15);overflow:hidden}',
  '.tks-model-bar{height:100%;border-radius:3px;background:#e5764c}',
  '.tks-runcard{font-size:13px;line-height:1.7}',
].join('\n')

return {
  inject: ['timer'],
  apply(ctx) {
    intervalRef = (callback, delay) => ctx.interval(callback, delay)
    // 语言跟随：locale 服务可选；active === 'zh' 用中文，其他（en）用英文
    const locale = ctx.get('locale')
    if (locale !== undefined) {
      try {
        const snap = locale.getLocale()
        activeLang = snap && snap.active === 'zh' ? 'zh' : 'en'
      } catch (e) { /* keep default */ }
      ctx.effect(() => locale.subscribe(() => {
        try {
          const snap = locale.getLocale()
          activeLang = snap && snap.active === 'zh' ? 'zh' : 'en'
        } catch (e) { /* keep current */ }
        for (const fn of i18nListeners) fn()
      }))
    }
    styles.insert(CSS) // styles 是 Builtin（模块级），不是 ctx Service
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'token-stats', order: 20, label: () => {
        // 读取调用时刻的 locale 快照（不依赖 subscribe 回调时序：
        // shell 的 settings 列表在 locale 变化时会同步重渲染并重新调用 label）
        if (locale !== undefined) {
          try {
            const snap = locale.getLocale()
            return snap.active === 'zh' ? DICT.zh.title : DICT.en.title
          } catch (e) { /* fall through */ }
        }
        return t('title')
      } },
      (props) => h(Dashboard, props),
    ))
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      (props) => h(RunCard, props),
    ))
  },
}
