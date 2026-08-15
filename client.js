// ===== Token 用量统计 · Client 半区（插件 toksta-5）=====
//
// 用法：本文件内容即 cordis_define 的 code.client「函数体」——整段复制粘贴即可。
// 依赖（部署前用 cordis_inspect_query 核对）：
//   - Client Builtin：React、host、styles（styles 是 Builtin！不能用 ctx.get('styles')）
//   - Client Service：timer（inject: ['timer']，组件内经模块级桥调用 ctx.interval）
//   - Client Slot：settings.section（list/root，注册 {id, order, label}）、
//     tool.view.cordis（keyed，key 只能是 'self'）
// 版本：v4（待部署；v3 对应运行中的 pkg-11）
// v4 变更：
//   1. 热力图方块悬停显示自定义提示：「x月x日消耗了 xx Token · N 次请求」
//   2. 移除「每周 / 累计」两个 tab，只保留每日视图
//   3. 热力图改为按日历年分页（一页一年）；前一年无记录时不显示「前一年」入口
//   4. 统计卡数值自适应缩小字号，保证一行内显示（5938.2 万 / 2 小时 1 分不换行）
//   5. 各统计卡的标签行（累计 Token 数等）统一高度对齐

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
// 悬停提示文案：「8月15日消耗了 27.3 万 Token · 34 次请求」
function tipText(cell) {
  const m = parseInt(cell.date.slice(5, 7), 10)
  const d = parseInt(cell.date.slice(8, 10), 10)
  const head = m + '月' + d + '日'
  return cell.total > 0
    ? head + '消耗了 ' + fmtTokens(cell.total) + ' Token · ' + cell.requests + ' 次请求'
    : head + '没有 Token 消耗'
}
// 组装某一日历年的网格（列=周，周日在上；本年截到今天，越界/未来格隐藏）
function buildGrid(days, year) {
  const map = new Map()
  for (const d of days) map.set(d.date, d)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const thisYear = today.getFullYear()
  const end = year === thisYear ? today : new Date(year, 11, 31)
  const start = new Date(year, 0, 1)
  start.setDate(start.getDate() - start.getDay()) // 对齐到本周周日
  const weeks = []
  const cursor = new Date(start)
  let max = 0
  while (cursor.getTime() <= end.getTime()) {
    const week = []
    for (let i = 0; i < 7; i += 1) {
      const key = dayKeyOf(cursor.getTime())
      const day = map.get(key)
      const total = day ? day.total : 0
      const inYear = cursor.getFullYear() === year
      const future = cursor.getTime() > today.getTime()
      week.push({
        date: key,
        total: total,
        requests: day ? day.requests : 0,
        hidden: !inYear || future,
      })
      if (inYear && !future && total > max) max = total
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push(week)
  }
  // 每月标签：取该列首个可见格，与前一列月份不同则标记
  const monthLabels = []
  let prevMonth = -1
  for (const w of weeks) {
    let label = ''
    for (const c of w) {
      if (!c.hidden) {
        const m = parseInt(c.date.slice(5, 7), 10)
        if (m !== prevMonth) { label = m + '月'; prevMonth = m }
        break
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
// 不经过 React state，直接改内联样式，避免测量-渲染循环；
// ResizeObserver 存在时跟随卡片宽度变化实时调整（不存在时随重渲染/文本变化重测）。
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
  const g = buildGrid(props.days, props.year)
  const colCount = g.weeks.length
  const columns = g.weeks.map((week, wi) =>
    h('div', { key: wi, className: 'tks-col' },
      week.map((c, ci) => {
        // 靠左/右边缘的列，提示框改为贴边对齐，避免被滚动容器裁掉
        let edge = ''
        if (wi < 8) edge = ' tks-tip-left'
        else if (wi >= colCount - 2) edge = ' tks-tip-right'
        return h('div', {
          key: ci,
          className: 'tks-cell tks-lv' + (c.hidden ? 0 : cellLevel(c.total, g.max)) + edge,
          style: c.hidden ? { visibility: 'hidden' } : undefined,
        }, c.hidden ? null : h('span', { className: 'tks-tip' }, tipText(c)))
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
  const yearSt = React.useState((new Date()).getFullYear())
  const year = yearSt[0]; const setYear = yearSt[1]
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
  // 分页：前一年有记录才可往前翻；最多翻到本年
  const thisYear = (new Date()).getFullYear()
  const earliest = data.days.length ? data.days[0].date : null
  const hasPrev = earliest !== null && earliest < year + '-01-01'
  const hasNext = year < thisYear
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
        h('span', { className: 'tks-pager' },
          hasPrev
            ? h('button', { className: 'tks-page-btn', onClick: () => setYear(year - 1) }, '‹ 前一年')
            : null,
          h('span', { className: 'tks-page-year' }, year + ' 年'),
          hasNext
            ? h('button', { className: 'tks-page-btn', onClick: () => setYear(year + 1) }, '后一年 ›')
            : null)),
      h(Heatmap, { days: data.days, year: year })))
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
  '.tks-card{flex:1;display:flex;flex-direction:column;align-items:center;padding:16px 8px 12px;text-align:center;min-width:0}',
  '.tks-card+.tks-card{border-left:1px solid rgba(128,128,128,.2)}',
  // 数值：nowrap + 定高 30px，字号由 FitValue 自适应收缩；定高保证各卡标签同一高度
  '.tks-card-value{width:100%;height:30px;line-height:30px;font-size:22px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.tks-card-label{font-size:12px;opacity:.6;margin-top:6px}',
  '.tks-card-sub{font-size:11px;opacity:.45;margin-top:4px}',
  '.tks-activity-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}',
  '.tks-activity-title{font-size:15px;font-weight:600}',
  '.tks-pager{display:flex;align-items:center;gap:8px}',
  '.tks-page-btn{border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;font-size:12px;padding:2px 8px;cursor:pointer;color:inherit;opacity:.75}',
  '.tks-page-btn:hover{opacity:1}',
  '.tks-page-year{font-size:13px;opacity:.75;min-width:44px;text-align:center}',
  // 顶部留白给首行方块的悬停提示（容器 overflow-x:auto 会同时裁剪纵向溢出）
  '.tks-heatmap-wrap{overflow-x:auto;padding:32px 2px 8px}',
  '.tks-heatmap{display:flex;gap:3px}',
  '.tks-col{display:flex;flex-direction:column;gap:3px}',
  '.tks-cell{width:10px;height:10px;border-radius:2px;display:inline-block;position:relative}',
  '.tks-lv0{background:rgba(128,128,128,.14)}',
  '.tks-lv1{background:#f6c9b3}',
  '.tks-lv2{background:#ef9f7d}',
  '.tks-lv3{background:#e5764c}',
  '.tks-lv4{background:#c74e24}',
  // 自定义悬停提示：纯 CSS 跟随 :hover，不依赖 window/document
  '.tks-tip{display:none;position:absolute;bottom:15px;left:50%;transform:translateX(-50%);z-index:60;background:rgba(32,32,32,.94);color:#fafafa;font-size:11px;line-height:1.5;padding:3px 8px;border-radius:5px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.18)}',
  '.tks-cell:hover .tks-tip{display:block}',
  '.tks-tip-left .tks-tip{left:-3px;transform:none}',
  '.tks-tip-right .tks-tip{left:auto;right:-3px;transform:none}',
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
