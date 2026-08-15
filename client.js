// ===== Token 用量统计 · Client 半区（插件 toksta-5）=====
//
// 用法：本文件内容即 cordis_define 的 code.client「函数体」——整段复制粘贴即可。
// 依赖（部署前用 cordis_inspect_query 核对）：
//   - Client Builtin：React、host、styles（styles 是 Builtin！不能用 ctx.get('styles')）
//   - Client Service：timer（inject: ['timer']，组件内经模块级桥调用 ctx.interval）
//   - Client Slot：settings.section（list/root，注册 {id, order, label}）、
//     tool.view.cordis（keyed，key 只能是 'self'）
// 版本：v11（部署中；v10 = pkg-18）
// v11 变更（仅 client.js，观感微调）：
//   1. 月份标签带上年份：「2026年8月」（跨年视图一目了然）
//   2. 格子空隙 2px→1px（网格横向/纵向、月份行），尺寸上限 14→16px，宽度公式同步

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
// 网格列数：53 列 ≈ 一年（与参考截图一致），最后一列以今天结尾
const GRID_COLUMNS = 53
// 组装滚动网格：每列 = 连续 7 天（上→下 = 早→晚），列尾固定为今天的星期，
// 最后一列 = [今天-6 .. 今天]，今天恒在最右下角；向左每列再往前推 7 天。
function buildGrid(days, colCount) {
  const map = new Map()
  for (const d of days) map.set(d.date, d)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const weeks = []
  let max = 0
  for (let k = 0; k < colCount; k += 1) {
    // 该列最后一天：今天 - 7*(colCount-1-k) 天（恒为今天的星期）
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
  // 月份标签：锚定「包含该月 1 日」的那一列（与 GitHub 一致）；
  // 网格起点落在月中间时，该月不标记。
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
        if (label === '') label = Math.floor(m / 12) + '年' + ((m % 12) + 1) + '月'
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
  const wrapRef = React.useRef(null)
  const g = buildGrid(props.days, GRID_COLUMNS)
  // 宽度自适应：按容器宽度计算格子尺寸（--tks-size，4~14px），gap=0 精确填充；
  // 保证 53 列总宽不超出容器（配合容器 overflow-x:hidden，任何时刻都不会出现滚动条）；
  // 直接改内联变量，不经 React state。
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
        // 靠左/右边缘的列，提示框改为贴边对齐，避免被滚动容器裁掉
        let edge = ''
        if (wi < 8) edge = ' tks-tip-left'
        else if (wi >= colCount - 2) edge = ' tks-tip-right'
        return h('div', {
          key: ci,
          className: 'tks-cell tks-lv' + cellLevel(c.total, g.max) + edge,
        }, h('span', { className: 'tks-tip' }, tipText(c)))
      })))
  return h('div', { ref: wrapRef, className: 'tks-heatmap-wrap' },
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
        h('span', { className: 'tks-activity-title' }, 'Token 活动')),
      h(Heatmap, { days: data.days })))
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
  '.tks-activity-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}',
  '.tks-activity-title{font-size:15px;font-weight:600}',
  // 顶部留白 22px 给首行方块的悬停提示（提示框已缩小）
  // overflow-x:hidden：稳态格子必然 ≤ 容器宽（fit 精确填充），不需要滚动条；
  //   旧版 auto 时，月份行 nowrap 标签文字溢出会把 scrollWidth 撑过 clientWidth，
  //   特定宽度下滚动条闪现；hidden 从根上消除
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
  // 自定义悬停提示：纯 CSS 跟随 :hover，不依赖 window/document
  '.tks-tip{display:none;position:absolute;bottom:13px;left:50%;transform:translateX(-50%);z-index:60;background:rgba(32,32,32,.94);color:#fafafa;font-size:10px;line-height:1.45;padding:2px 6px;border-radius:4px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.18)}',
  '.tks-cell:hover .tks-tip{display:block}',
  '.tks-tip-left .tks-tip{left:-1px;transform:none}',
  '.tks-tip-right .tks-tip{left:auto;right:-1px;transform:none}',
  // overflow:hidden：nowrap 标签文字（如「2026年10月」）宽过列距，防止其撑大 scrollable overflow
  '.tks-months{display:flex;gap:1px;margin-top:6px;font-size:10px;opacity:.55;overflow:hidden}',
  // span 宽 = 格子宽，pitch = 格子宽 + 1px gap，与热力网格严格同宽对齐
  '.tks-months span{width:var(--tks-size,12px);overflow:visible;white-space:nowrap}',
  '.tks-legend{display:flex;align-items:center;gap:2px;font-size:11px;opacity:.6;margin-top:10px;justify-content:flex-end}',
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
