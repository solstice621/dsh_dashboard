// ===== Token 用量统计 · Client 半区（插件 toksta-5）=====
//
// 用法：本文件内容即 cordis_define 的 code.client「函数体」——整段复制粘贴即可。
// 依赖（部署前用 cordis_inspect_query 核对）：
//   - Client Builtin：React、host、styles（styles 是 Builtin！不能用 ctx.get('styles')）
//   - Client Service：timer（inject: ['timer']，组件内经模块级桥调用 ctx.interval）
//   - Client Slot：settings.section（list/root，注册 {id, order, label}）、
//     tool.view.cordis（keyed，key 只能是 'self'）
// 版本：v3（对应运行中的 pkg-11）

function h() { return React.createElement.apply(null, arguments) }
function pad2(n) { return n < 10 ? '0' + n : '' + n }
function dayKeyOf(time) {
  const d = new Date(time)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}
function fmtTokens(n) {
  if (!n) return '0'
  if (n >= 1e8) {
    const v = (n / 1e8).toFixed(1)
    return (v.endsWith('.0') ? v.slice(0, -2) : v) + ' 亿'
  }
  if (n >= 1e4) {
    const v = (n / 1e4).toFixed(1)
    return (v.endsWith('.0') ? v.slice(0, -2) : v) + ' 万'
  }
  return String(n)
}
function fmtDuration(ms) {
  if (!ms) return '0 分钟'
  const hour = Math.floor(ms / 3600000)
  const min = Math.round((ms % 3600000) / 60000)
  if (hour > 0) return hour + ' 小时 ' + min + ' 分'
  if (min > 0) return min + ' 分钟'
  return Math.floor(ms / 1000) + ' 秒'
}
function cellLevel(v, max) {
  if (!v || max <= 0) return 0
  const r = Math.log(v + 1) / Math.log(max + 1)
  if (r >= 0.75) return 4
  if (r >= 0.45) return 3
  if (r >= 0.18) return 2
  return 1
}
// 组装 53 列 × 7 行网格（列=周，周日在上）
function buildGrid(days, mode) {
  const map = new Map()
  for (const d of days) map.set(d.date, d)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const anchor = new Date(today); anchor.setDate(anchor.getDate() - 364)
  const start = new Date(anchor); start.setDate(start.getDate() - start.getDay())
  const weeks = []
  const cursor = new Date(start)
  let cum = 0
  while (cursor.getTime() <= today.getTime()) {
    const week = []
    let weekTotal = 0
    for (let i = 0; i < 7; i += 1) {
      const key = dayKeyOf(cursor.getTime())
      const day = map.get(key)
      const total = day ? day.total : 0
      cum += total
      weekTotal += total
      week.push({
        date: key,
        total: total,
        requests: day ? day.requests : 0,
        cum: cum,
        future: cursor.getTime() > today.getTime(),
      })
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push({ cells: week, weekTotal: weekTotal })
  }
  // 每月标签：该列首日与前一列首日月份不同则标记
  const monthLabels = []
  let prevMonth = -1
  for (const w of weeks) {
    const m = new Date(w.cells[0].date + 'T00:00:00').getMonth()
    monthLabels.push(m !== prevMonth ? (m + 1) + '月' : '')
    prevMonth = m
  }
  // 当前模式下的最大值（色阶基准）
  let max = 0
  for (const w of weeks) {
    for (const c of w.cells) {
      const v = mode === 'weekly' ? w.weekTotal : mode === 'cumulative' ? c.cum : c.total
      if (v > max) max = v
    }
  }
  return { weeks: weeks, monthLabels: monthLabels, max: max }
}

// 定时器桥：apply 中捕获 ctx.interval 后注入（组件内无法直接访问 ctx）
let intervalRef = null
function startInterval(callback, delay) {
  return intervalRef ? intervalRef(callback, delay) : null
}

function StatCard(props) {
  return h('div', { className: 'tks-card' },
    h('div', { className: 'tks-card-value' }, props.value),
    h('div', { className: 'tks-card-label' }, props.label),
    props.sub ? h('div', { className: 'tks-card-sub' }, props.sub) : null)
}

function Heatmap(props) {
  const g = buildGrid(props.days, props.mode)
  const columns = g.weeks.map((w, wi) =>
    h('div', { key: wi, className: 'tks-col' },
      w.cells.map((c, ci) => {
        const v = props.mode === 'weekly' ? w.weekTotal
          : props.mode === 'cumulative' ? c.cum : c.total
        const tip = props.mode === 'weekly'
          ? c.date + ' 所在周 · ' + fmtTokens(w.weekTotal) + ' Token'
          : c.date + ' · ' + fmtTokens(v) + ' Token · ' + c.requests + ' 次请求'
        return h('div', {
          key: ci,
          className: 'tks-cell tks-lv' + (c.future ? 0 : cellLevel(v, g.max)),
          style: c.future ? { visibility: 'hidden' } : undefined,
          title: tip,
        })
      })))
  return h('div', { className: 'tks-heatmap-wrap' },
    h('div', { className: 'tks-heatmap' }, columns),
    h('div', { className: 'tks-months' },
      g.monthLabels.map((m, i) => h('span', { key: i }, m))),
    h('div', { className: 'tks-legend' }, '少',
      h('span', { className: 'tks-cell tks-lv0' }),
      h('span', { className: 'tks-cell tks-lv1' }),
      h('span', { className: 'tks-cell tks-lv2' }),
      h('span', { className: 'tks-cell tks-lv3' }),
      h('span', { className: 'tks-cell tks-lv4' }), '多'))
}

function Dashboard(props) {
  const st = React.useState(null)
  const data = st[0]; const setData = st[1]
  const errSt = React.useState(null)
  const error = errSt[0]; const setError = errSt[1]
  const tabSt = React.useState('daily')
  const mode = tabSt[0]; const setMode = tabSt[1]
  const load = function () {
    host.call('get-stats').then(setData, (e) => setError(String(e)))
  }
  React.useEffect(() => {
    load()
    const t = startInterval(load, 30000) // 每 30s 自动刷新一次
    return t || undefined
  }, [])
  if (error) return h('div', { className: 'tks-root' }, '加载失败：', error)
  if (!data) return h('div', { className: 'tks-root' }, '加载中…')
  const tabs = [['daily', '每日'], ['weekly', '每周'], ['cumulative', '累计']]
  return h('div', { className: 'tks-root' },
    h('div', { className: 'tks-header' },
      h('div', null,
        h('div', { className: 'tks-title' }, 'Token 用量'),
        h('div', { className: 'tks-subtitle' },
          data.scanning
            ? '正在扫描历史会话（' + data.scannedSessions + '/' + data.totalSessions + '）…'
            : '共 ' + data.totalSessions + ' 个会话 · ' + data.totalRequests + ' 次请求 · ' + data.activeDays + ' 个活跃日')),
      h('button', {
        className: 'tks-btn',
        onClick: () => host.call('rescan').then(setData),
      }, '重新扫描')),
    h('div', { className: 'tks-cards' },
      h(StatCard, { value: fmtTokens(data.totalTokens), label: '累计 Token 数' }),
      h(StatCard, {
        value: data.peakDay ? fmtTokens(data.peakDay.total) : '0',
        label: '峰值 Token 数',
        sub: data.peakDay ? data.peakDay.date + ' · 单次峰值 ' + fmtTokens(data.peakStepTokens) : null,
      }),
      h(StatCard, {
        value: fmtDuration(data.longestChatMs),
        label: '最长聊天时长',
        sub: '最长单轮 ' + fmtDuration(data.longestTurnMs),
      }),
      h(StatCard, { value: data.streakCurrent + ' 天', label: '当前连续天数' }),
      h(StatCard, { value: data.streakLongest + ' 天', label: '最长连续天数' })),
    h('div', { className: 'tks-activity' },
      h('div', { className: 'tks-activity-head' },
        h('span', { className: 'tks-activity-title' }, 'Token 活动'),
        h('span', { className: 'tks-tabs' },
          tabs.map((t) => h('button', {
            key: t[0],
            className: 'tks-tab' + (mode === t[0] ? ' active' : ''),
            onClick: () => setMode(t[0]),
          }, t[1])))),
      h(Heatmap, { days: data.days, mode: mode })))
}

function RunCard() {
  const st = React.useState(null)
  const data = st[0]; const setData = st[1]
  React.useEffect(() => {
    host.call('get-stats').then(setData, () => {})
  }, [])
  if (!data) return h('div', null, 'Token 统计加载中…')
  return h('div', { className: 'tks-runcard' },
    h('b', null, 'Token 用量：'),
    '累计 ' + fmtTokens(data.totalTokens) +
    ' · 今日连续 ' + data.streakCurrent + ' 天' +
    ' · 峰值日 ' + (data.peakDay ? fmtTokens(data.peakDay.total) : '0'),
    h('div', { className: 'tks-card-sub' }, '完整图表见「设置 → Token 用量」'))
}

const CSS = [
  '.tks-root{padding:8px 4px;max-width:960px}',
  '.tks-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}',
  '.tks-title{font-size:20px;font-weight:600}',
  '.tks-subtitle{font-size:12px;opacity:.6;margin-top:4px}',
  '.tks-btn{font-size:12px;padding:4px 12px;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;cursor:pointer;color:inherit}',
  '.tks-cards{display:flex;border:1px solid rgba(128,128,128,.25);border-radius:10px;overflow:hidden;margin-bottom:24px}',
  '.tks-card{flex:1;padding:16px 12px;text-align:center}',
  '.tks-card+.tks-card{border-left:1px solid rgba(128,128,128,.2)}',
  '.tks-card-value{font-size:22px;font-weight:600}',
  '.tks-card-label{font-size:12px;opacity:.6;margin-top:6px}',
  '.tks-card-sub{font-size:11px;opacity:.45;margin-top:4px}',
  '.tks-activity-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}',
  '.tks-activity-title{font-size:15px;font-weight:600}',
  '.tks-tab{border:none;background:none;font-size:13px;padding:4px 8px;cursor:pointer;opacity:.5;color:inherit}',
  '.tks-tab.active{opacity:1;font-weight:600;border-bottom:2px solid currentColor}',
  '.tks-heatmap-wrap{overflow-x:auto;padding-bottom:8px}',
  '.tks-heatmap{display:flex;gap:3px}',
  '.tks-col{display:flex;flex-direction:column;gap:3px}',
  '.tks-cell{width:10px;height:10px;border-radius:2px;display:inline-block}',
  '.tks-lv0{background:rgba(128,128,128,.14)}',
  '.tks-lv1{background:#f6c9b3}',
  '.tks-lv2{background:#ef9f7d}',
  '.tks-lv3{background:#e5764c}',
  '.tks-lv4{background:#c74e24}',
  '.tks-months{display:flex;gap:3px;margin-top:6px;font-size:10px;opacity:.55}',
  '.tks-months span{width:13px;overflow:visible;white-space:nowrap}',
  '.tks-legend{display:flex;align-items:center;gap:3px;font-size:11px;opacity:.6;margin-top:10px;justify-content:flex-end}',
  '.tks-runcard{font-size:13px;line-height:1.7}',
].join('\n')

return {
  inject: ['timer'],
  apply(ctx) {
    intervalRef = (callback, delay) => ctx.interval(callback, delay)
    styles.insert(CSS) // styles 是 Builtin（模块级），不是 ctx Service
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'token-stats', order: 20, label: () => 'Token 用量' },
      (props) => h(Dashboard, props),
    ))
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      (props) => h(RunCard, props),
    ))
  },
}
