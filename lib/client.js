// ===== dsh-token-stats · Client 半（bundle 版，浏览器模块）=====
// 客户端模块工厂格式：window.__ModuleLoader__.load({ id, factory })
// 与动态插件版 client.js 同源 UI（统计卡 / 每日·每周热力图 / 洞察 / 模型排名），差异：
//   1. 数据改为 fetch('/api/token-stats')（host 经 webServer 路由供数，无 harness RPC）
//   2. 无 tool.view.cordis Run 卡片（那是动态插件机制）；仅注册设置页分区
//   3. 样式经 document <style> 注入（bundle 环境是真实浏览器，window/document 可用）
window.__ModuleLoader__.load({
  id: "dsh-token-stats",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

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
    // 日期头部：「2026年8月15日」
    function dateHead(date) {
      const y = parseInt(date.slice(0, 4), 10)
      const m = parseInt(date.slice(5, 7), 10)
      const d = parseInt(date.slice(8, 10), 10)
      return y + '年' + m + '月' + d + '日'
    }
    // 悬停提示文案：「2026年8月15日消耗了 27.3 万 Token · 34 次请求」
    function tipText(cell) {
      const head = dateHead(cell.date)
      return cell.total > 0
        ? head + '消耗了 ' + fmtTokens(cell.total) + ' Token · ' + cell.requests + ' 次请求'
        : head + '没有 Token 消耗'
    }
    // 每周悬停提示：「2026年8月9日 ~ 2026年8月15日 所在周消耗了 27.3 万 Token」
    function weekTipText(start, end, total) {
      return dateHead(start) + ' ~ ' + dateHead(end) + ' 所在周消耗了 ' + fmtTokens(total) + ' Token'
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
            if (label === '') label = ((m % 12) + 1) + '月'
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
        ['聊天总数', d.totalTurns + ' 轮'],
        ['LLM 请求数', d.totalRequests + ' 次'],
        ['会话总数', d.totalSessions + ' 个'],
        ['活跃天数', d.activeDays + ' 天'],
        ['缓存命中率', hit + ' %'],
        ['平均每轮 Token', perTurnTokens],
        ['平均每轮时长', fmtDuration(perTurnMs)],
      ]
      return h('div', { className: 'tks-insight-panel' },
        h('div', { className: 'tks-insight-title' }, '洞察'),
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
        h('div', { className: 'tks-insight-title' }, '最喜欢的模型'),
        models.length === 0
          ? h('div', { className: 'tks-insight-empty' }, '暂无模型数据')
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

    function Dashboard() {
      const st = React.useState(null)
      const data = st[0]; const setData = st[1]
      const errSt = React.useState(null)
      const error = errSt[0]; const setError = errSt[1]
      const viewSt = React.useState('daily')
      const view = viewSt[0]; const setView = viewSt[1]
      const load = function () {
        fetch('/api/token-stats', { cache: 'no-store' })
          .then((r) => r.json())
          .then(setData, (e) => setError(String(e)))
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
            h('div', { className: 'tks-title' }, '统计'),
            h('div', { className: 'tks-subtitle' },
              data.scanning
                ? '正在扫描历史会话（' + data.scannedSessions + '/' + data.totalSessions + '）…'
                : '共 ' + data.totalSessions + ' 个会话 · ' + data.totalRequests + ' 次请求 · ' + data.activeDays + ' 个活跃日'))),
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
            h('div', { className: 'tks-tabs' },
              h('button', {
                className: 'tks-tab' + (view === 'daily' ? ' active' : ''),
                onClick: () => setView('daily'),
              }, '每日'),
              h('button', {
                className: 'tks-tab' + (view === 'weekly' ? ' active' : ''),
                onClick: () => setView('weekly'),
              }, '每周'))),
          h(Heatmap, { days: data.days, view: view }),
          h('div', { className: 'tks-insights-row' },
            h(Insights, { data: data }),
            h(ModelRanking, { data: data }))))
    }

    const CSS = [
      '.tks-root{padding:8px 4px;max-width:960px}',
      '.tks-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}',
      '.tks-title{font-size:20px;font-weight:600}',
      '.tks-subtitle{font-size:12px;opacity:.6;margin-top:4px}',
      '.tks-cards{display:flex;border:1px solid rgba(128,128,128,.25);border-radius:10px;overflow:hidden;margin-bottom:24px}',
      '.tks-card{flex:1;display:flex;flex-direction:column;align-items:center;padding:16px 8px 12px;text-align:center;min-width:0}',
      '.tks-card+.tks-card{border-left:1px solid rgba(128,128,128,.2)}',
      '.tks-card-value{width:100%;height:30px;line-height:30px;font-size:22px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tks-card-label{font-size:12px;opacity:.6;margin-top:6px}',
      '.tks-card-sub{font-size:11px;opacity:.45;margin-top:4px}',
      '.tks-activity-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}',
      '.tks-activity-title{font-size:15px;font-weight:600}',
      '.tks-tabs{display:flex;gap:2px}',
      '.tks-tab{border:none;background:none;font-size:13px;padding:4px 8px;cursor:pointer;opacity:.5;color:inherit}',
      '.tks-tab.active{opacity:1;font-weight:600;border-bottom:2px solid currentColor}',
      '.tks-heatmap-wrap{overflow-x:hidden;padding:22px 2px 8px;display:flex;flex-direction:column;align-items:safe center}',
      '.tks-heatmap{display:flex;gap:1px}',
      '.tks-col{display:flex;flex-direction:column;gap:1px}',
      '.tks-cell{width:var(--tks-size,12px);height:var(--tks-size,12px);border-radius:2px;display:inline-block;position:relative}',
      '.tks-lv0{background:rgba(128,128,128,.14)}',
      '.tks-lv1{background:#f6c9b3}',
      '.tks-lv2{background:#ef9f7d}',
      '.tks-lv3{background:#e5764c}',
      '.tks-lv4{background:#c74e24}',
      '.tks-tip{display:none;position:absolute;bottom:13px;left:50%;transform:translateX(-50%);z-index:60;background:rgba(32,32,32,.94);color:#fafafa;font-size:10px;line-height:1.45;padding:2px 6px;border-radius:4px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.18)}',
      '.tks-cell:hover .tks-tip{display:block}',
      '.tks-tip-left .tks-tip{left:-1px;transform:none}',
      '.tks-tip-right .tks-tip{left:auto;right:-1px;transform:none}',
      '.tks-months{display:flex;gap:1px;margin-top:6px;font-size:10px;opacity:.55;overflow:hidden}',
      '.tks-months span{width:var(--tks-size,12px);overflow:visible;white-space:nowrap}',
      '.tks-weekly{display:flex;gap:1px}',
      '.tks-week-full{background:#e5764c}',
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
    ].join('\n')

    // 样式注入：bundle 环境是真实浏览器；apply 时挂载，dispose 时移除
    let styleEl = null
    function ensureStyles() {
      if (styleEl !== null || typeof document === 'undefined') return
      styleEl = document.createElement('style')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
    }
    function removeStyles() {
      if (styleEl !== null && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      styleEl = null
    }

    exports.inject = ['timer']
    exports.apply = (ctx) => {
      intervalRef = (callback, delay) => ctx.interval(callback, delay)
      ensureStyles()
      const slots = ctx.get('slots')
      if (slots !== undefined) {
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'token-stats', order: 20, label: () => '统计' },
          () => h(Dashboard),
        ))
      }
      ctx.effect(() => () => { removeStyles() })
    }
    return module.exports;
  }
});
