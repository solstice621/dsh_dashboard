# Token 用量统计插件（Codex 风格）— 完整策划与实现

> 目标：为 DeepSeek Harness（dsh）开发一个动态 Cordis 插件，复刻 Codex 个人主页的
> Token 统计效果：累计/峰值 Token、最长聊天时长、连续天数、以及 GitHub 风格的
> Token 活动热力图（每日 / 每周 / 累计三个视图）。
>
> 本文档同时是「无视觉能力模型」的实施依据：第 1 节是对参考截图的完整文字描述，
> 第 2 节是从 harness 源码中核实过的接口事实，第 3~5 节是设计与口径，第 6 节是
> 可直接 `cordis_define` 的完整代码，第 7 节是部署步骤与排错。

---

## 1. 参考截图的完整描述（Codex 用量主页）

截图是 Codex 网页端的个人用量主页，浅色主题，中文界面，自上而下三个区域：

**头部（居中）**
- 圆形头像（约 96px）。
- 显示名「爱弥斯」，大号粗体深色字。
- 一行灰色小字：handle `@qiuzihan32`，后跟一个圆角描边小徽章「Pro」。

**统计卡片区（一行 5 格，等宽，格间有细分隔线）**
每格上方是大号数值、下方是灰色标签：
| 数值 | 标签 | 含义 |
| --- | --- | --- |
| 115.9亿 | 累计 Token 数 | 历史全部 Token 消耗 |
| 5.3亿 | 峰值 Token 数 | 单日最高 Token 消耗 |
| 7 小时 20 分 | 最长聊天时长 | 单次聊天最长时长 |
| 12 天 | 当前连续天数 | 截至今天（或昨天）的连续活跃天数 |
| 19 天 | 最长连续天数 | 历史最长连续活跃天数 |

数值中文格式化：`亿`=1e8（保留 1 位小数），时长用「X 小时 Y 分」，天数用「N 天」。

**Token 活动区**
- 左侧标题「Token 活动」；右侧三个 tab：`每日`（选中，深色）`每周` `累计`（未选，灰色）。
- 主体是 GitHub 贡献图风格的热力图：53 列 × 7 行的小圆角方块网格，一列=一周
  （周日在上），一格=一天；颜色从浅灰（无活动）→ 浅鲑鱼粉 → 深橙红，颜色越深
  Token 越多。底部横轴是月份标签：9月 10月 11月 12月 1月 … 8月（约 12 个月滚动窗口）。
- 图中可见 6 月起活动明显增多，7~8 月（最右几列）最密集。

**本插件的取舍**：头像/昵称/Pro 徽章属于账号体系，harness 内没有对应数据源，
头部改为简单标题行「Token 用量」+ 数据说明 + 手动刷新按钮；其余 1:1 复刻。

---

## 2. 已从 harness 源码核实的接口事实

以下事实均来自本机 `~/.dsh/profiles/node_modules/@deepseek-ai/` 下的类型定义与
真实会话日志，不是猜测：

### 2.1 数据源：usage 记录在会话事件日志里

- 每个会话持久化为 `~/.dsh/sessions/<工作目录编码>/<sessionId>/session.jsonl.zstd`
  （多个 zstd frame 拼接，Node ≥22 可用 `zlib.zstdDecompressSync` 逐帧解压）。
- 事件行形如 `{"type":"assistant/message","seq":1037,"time":1786798363795,"data":{...}}`。
- **`assistant/message` 事件携带 `data.usage`**（`dsh-session` 类型定义确认：
  "Carries the step's `usage` when the adapter reported token accounting"）。
- `TokenUsage`（`dsh-llm`）：`{ inputTokens, outputTokens, cacheReadTokens?,
  cacheWriteTokens?, reasoningTokens? }`。**计数互斥**：cache 命中不计入
  inputTokens，所以一次请求的总消耗 = 四项之和（reasoningTokens 是
  outputTokens 的子集信息，不另加）。
- `turn/start {turn}` / `turn/end {turn, reason}`：用于聊天时长。
- 实测样例：`{"chunk":{"type":"usage","usage":{"inputTokens":7133,"outputTokens":628,"cacheReadTokens":256}}}`。

### 2.2 Host 侧可用能力（dsh-base bundle 已挂载）

- **历史回补**：`ctx.get('sessionQuery')`（`session-query-sqlite` 已在
  dsh-base/cordis.patch.yml 挂载）：
  - `listSessions()` → `SessionRecord[]`，`record.header = { id, createdAt, cwd?, origin? ... }`。
  - `readSession(sessionId)` → `{ session: SessionHeader, events: SessionEvent[] }`，
    完整原始事件日志（已做修复与回放校验）。
- **实时增量**：Host 事件（`dsh-session` 的 Events 声明，`@mode emit`）：
  - `ctx.on('session/event', (session, event) => …)` — 每次日志追加后触发。
  - `ctx.on('session/created', (session) => …)` — 新会话进入 store。
    注意：**seed/恢复的历史事件不会重新 emit**，所以 created 时要 readSession 补折。
- **RPC**：Host 用 `harness.handle(method, handler)` 注册包内私有方法；
  Client 用 `host.call(method, args)` 调用；参数/返回值必须是无损 JSON。
- 事件对象、Session 是 live data：只读取叶子字段（`session.id`、`event.type`、
  `event.seq`、`event.time`、`event.data.usage.*`），不得整体 JSON.stringify。

### 2.3 Client 侧可用能力（dsh-web-app bundle 已挂载 cordis-client-runner）

- `settings.section` Slot：kind=`list`、scope=`root`；注册选项
  `{ name, id, order, label }`，`label` 可以是字符串或 `() => string`
  （`resolveSlotLabel` 确认）。组件收到 props `{ close }`。
  这就是「设置」里的完整分区页面，最适合放整个仪表盘。
- `tool.view.cordis` Slot：`key: 'self'` 时渲染在本插件最近一次 `cordis_run`
  的 Run 卡片里，适合做紧凑摘要。
- `styles` **Builtin**：`styles.insert(css)` 注入本包样式（注意：`styles` 是 Client
  Builtin，不是 ctx Service——`ctx.get('styles')` 会返回 undefined，必须直接调用
  模块级全局 `styles`）。
- Client 侧内置 `React`（用 `React.createElement`，禁止 JSX）。

### 2.4 运行环境

- **web profile（浏览器 UI）挂载了 cordis-host-runner / cordis-client-runner /
  ui-cordis**，动态插件要在 web 会话里 define & run。headless profile 没有
  client，只能跑纯 Host 插件。
- 插件代码是纯 JS 函数体：禁止 import/require/TS/JSX；不要假设
  `window/document/process/fetch` 存在。

---

## 3. 指标口径（精确定义）

| 指标 | 口径 |
| --- | --- |
| 累计 Token 数 | 全部会话、全部 `assistant/message` 事件的 usage 四项之和 |
| 峰值 Token 数 | **单日**（本地时区日期）Token 总量最大值；附「单次请求峰值」=单条 assistant/message usage 最大值 |
| 最长聊天时长 | 单会话内 `turn/start→turn/end` 墙钟时长之和的最大值（跨会话取 max）；附「最长单轮」=单个 turn 时长最大值 |
| 当前连续天数 | 有 Token 消耗的日期集合中，从今天（今天无则从昨天）向前连续不断的天数 |
| 最长连续天数 | 日期集合排序后最长连续段长度 |
| 热力图 | 日粒度 Token 总量，按本地时区；每日=当天值；每周=所在周 7 天总和；累计=截至当天的历史累加 |
| 统计范围 | 全部会话（含子代理会话）；每次 LLM 调用记 1 次「请求数」 |

日期键：`YYYY-MM-DD`，用 Host 本机时区（个人 harness 与浏览器同机，无时区偏差）。

---

## 4. 架构设计

```
┌────────────────────────── Host (Node 进程) ──────────────────────────┐
│ 启动时: sessionQuery.listSessions() → 逐会话 readSession() → 折事件   │
│ 运行中: ctx.on('session/event') 实时折叠                              │
│         ctx.on('session/created') → readSession() 补折 seed 历史      │
│ 去重:   每会话水位线 lastSeq（event.seq <= lastSeq 跳过）             │
│ 状态:   Map<日期,{input,output,cacheRead,cacheWrite,total,requests}>  │
│         Map<sessionId,{lastSeq,tokens,chatMs,turns}> + 全局计数       │
│ RPC:    harness.handle('get-stats')  → 完整仪表盘 JSON                │
│         harness.handle('rescan')     → 重新回补后返回同结构           │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ host.call (无损 JSON)
┌──────────────────────────────┴──────────────── Client (浏览器) ──────┐
│ settings.section(id='token-stats')  → 完整仪表盘（5 卡片+热力图+tabs）│
│ tool.view.cordis(key='self')        → Run 卡片里的紧凑摘要            │
│ styles.insert(css)                  → 本包样式                        │
└──────────────────────────────────────────────────────────────────────┘
```

**为什么不需要自己的持久化**：会话日志本身就是持久事实源。插件停掉/进程重启后，
重新折叠即可恢复全量统计。回补是异步后台任务（几十~几百个会话也是秒级），
UI 先显示「扫描中」，完成后自动呈现。（后续优化见第 8 节：水位线缓存。）

---

## 5. UI 设计（对照截图）

- 统计卡片：一行 5 格等宽 flex，格间 1px 分隔线；数值 22px/600，标签 12px 灰。
  第 2 格下方加一行小字「单日峰值 ＋ 单次请求峰值」，第 3 格加「另：最长单轮」。
- 热力图：CSS Grid，`grid-auto-flow: column; grid-template-rows: repeat(7, 10px)`，
  每格 10×10px、圆角 2px、间距 3px；底部月份标签行（该周首日与上一列月份不同
  时显示「M月」）。色阶 5 档（对数比）：
  `lv0 rgba(128,128,128,.14)`（空）、`lv1 #f6c9b3`、`lv2 #ef9f7d`、`lv3 #e5764c`、`lv4 #c74e24`。
- tabs：每日/每周/累计，选中深色下划线。
- 图例：少 □□□□□ 多；每格 title 提示「2026-08-15 · 1.2亿 Token · 34 次请求」。

---

## 6. 完整插件代码

### 6.1 `code.host`

```js
// ===== Token 用量统计 · Host =====
// 折叠全部会话日志中的 assistant/message usage 与 turn 时长，提供 RPC。
function pad2(n) { return n < 10 ? '0' + n : '' + n }
function dayKeyOf(time) {
  const d = new Date(time)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}
function shiftDayKey(key, delta) {
  const d = new Date(key + 'T00:00:00')
  d.setDate(d.getDate() + delta)
  return dayKeyOf(d.getTime())
}
function usageTotal(u) {
  return (u.inputTokens || 0) + (u.outputTokens || 0) +
    (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
}

return {
  apply(ctx) {
    const sessionQuery = ctx.get('sessionQuery')

    // ---- 自有聚合状态（纯 JSON，不持有 live 对象）----
    const days = new Map()      // dayKey -> {input,output,cacheRead,cacheWrite,total,requests}
    const sessions = new Map()  // sessionId -> {lastSeq,tokens,chatMs,turns,createdAt}
    const openTurns = new Map() // sessionId:turn -> startTime
    let disposed = false
    let ready = false
    let scanning = false
    let scannedSessions = 0
    let totalTokens = 0
    let totalRequests = 0
    let peakStepTokens = 0
    let longestTurnMs = 0
    let longestChatMs = 0
    let longestChatSessionId = null

    function sessionRec(id, createdAt) {
      let rec = sessions.get(id)
      if (!rec) {
        rec = { lastSeq: -1, tokens: 0, chatMs: 0, turns: 0, createdAt: createdAt || 0 }
        sessions.set(id, rec)
      }
      return rec
    }

    function foldEvent(sessionId, event) {
      const rec = sessionRec(sessionId)
      if (typeof event.seq === 'number') {
        if (event.seq <= rec.lastSeq) return
        rec.lastSeq = event.seq
      }
      const type = event.type
      const data = event.data
      if (!data) return
      if (type === 'assistant/message') {
        const u = data.usage
        if (!u) return
        const t = usageTotal(u)
        if (t <= 0) return
        const key = dayKeyOf(event.time)
        let day = days.get(key)
        if (!day) {
          day = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, requests: 0 }
          days.set(key, day)
        }
        day.input += u.inputTokens || 0
        day.output += u.outputTokens || 0
        day.cacheRead += u.cacheReadTokens || 0
        day.cacheWrite += u.cacheWriteTokens || 0
        day.total += t
        day.requests += 1
        totalTokens += t
        totalRequests += 1
        rec.tokens += t
        if (t > peakStepTokens) peakStepTokens = t
      } else if (type === 'turn/start') {
        openTurns.set(sessionId + ':' + data.turn, event.time)
      } else if (type === 'turn/end') {
        const k = sessionId + ':' + data.turn
        const start = openTurns.get(k)
        if (start !== undefined) {
          openTurns.delete(k)
          const dur = Math.max(0, event.time - start)
          rec.chatMs += dur
          rec.turns += 1
          if (dur > longestTurnMs) longestTurnMs = dur
          if (rec.chatMs > longestChatMs) {
            longestChatMs = rec.chatMs
            longestChatSessionId = sessionId
          }
        }
      }
    }

    async function foldSession(id) {
      try {
        const snap = await sessionQuery.readSession(id)
        const events = (snap && snap.events) || []
        for (let i = 0; i < events.length; i += 1) {
          if (disposed) return
          foldEvent(id, events[i])
        }
        scannedSessions += 1
      } catch (e) {
        console.warn('[token-stats] readSession failed:', id, e)
      }
    }

    async function backfill() {
      if (!sessionQuery || scanning) return
      scanning = true
      try {
        const list = await sessionQuery.listSessions()
        for (const item of list || []) {
          if (disposed) return
          const header = item && item.header
          if (!header || !header.id) continue
          sessionRec(header.id, header.createdAt)
          await foldSession(header.id)
        }
      } catch (e) {
        console.warn('[token-stats] listSessions failed:', e)
      } finally {
        scanning = false
        ready = true
      }
    }

    // 实时增量：水位线保证与回补不重复计数
    ctx.on('session/event', (session, event) => {
      if (!session || !event) return
      foldEvent(session.id, event)
    })

    // 新出现的会话：seed/恢复的历史不重新 emit，补折一次
    ctx.on('session/created', (session) => {
      if (!sessionQuery || !session) return
      const id = session.id
      sessionRec(id)
      Promise.resolve().then(() => foldSession(id))
    })

    function buildPayload() {
      const dayList = []
      let peakDay = null
      for (const entry of days) {
        const key = entry[0]
        const d = entry[1]
        dayList.push({
          date: key, input: d.input, output: d.output,
          cacheRead: d.cacheRead, cacheWrite: d.cacheWrite,
          total: d.total, requests: d.requests,
        })
        if (!peakDay || d.total > peakDay.total) peakDay = { date: key, total: d.total }
      }
      dayList.sort((a, b) => (a.date < b.date ? -1 : 1))
      // 连续天数
      const keySet = new Set(dayList.map((d) => d.date))
      let longest = 0
      let run = 0
      let prev = null
      for (const d of dayList) {
        if (prev !== null && shiftDayKey(prev, 1) === d.date) run += 1
        else run = 1
        if (run > longest) longest = run
        prev = d.date
      }
      let current = 0
      let cursor = dayKeyOf(Date.now())
      if (!keySet.has(cursor)) cursor = shiftDayKey(cursor, -1)
      while (keySet.has(cursor)) {
        current += 1
        cursor = shiftDayKey(cursor, -1)
      }
      return {
        ready: ready,
        scanning: scanning,
        scannedSessions: scannedSessions,
        totalTokens: totalTokens,
        totalRequests: totalRequests,
        totalSessions: sessions.size,
        activeDays: dayList.length,
        peakDay: peakDay,
        peakStepTokens: peakStepTokens,
        longestTurnMs: longestTurnMs,
        longestChatMs: longestChatMs,
        longestChatSessionId: longestChatSessionId,
        streakCurrent: current,
        streakLongest: longest,
        days: dayList,
      }
    }

    harness.handle('get-stats', async () => buildPayload())
    harness.handle('rescan', async () => { await backfill(); return buildPayload() })

    ctx.effect(() => () => { disposed = true })

    Promise.resolve().then(backfill)
  },
}
```

### 6.2 `code.client`

```js
// ===== Token 用量统计 · Client =====
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
    styles.insert(CSS) // styles 是 Builtin（模块级全局），不是 ctx Service
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
```

> 注：`ctx.interval` 依赖 `inject: ['timer']`（Host 与 Client 的 timer 都是 Service）。
> 若部署时 `Service.listService` 显示 client 没有 timer，把 30s 自动刷新删掉即可，
> 保留手动「重新扫描」按钮。

---

## 7. 部署步骤（在有 cordis_* 工具的 web 会话中执行）

本会话（CLI/headless）没有 cordis 工具；请打开 **web profile 的会话**（浏览器 UI），
把本文件交给那里的 agent，或直接说「按 ~/dsh-dashboard 仓库（README.md）部署插件」。
标准流程：

1. `cordis_inspect_list` → 拿到 Host/Client Provider 目录。
2. `cordis_inspect_query` 核对以下契约（若与本文不符，以实时结果为准并微调代码）：
   - Host `Service.listService`：`sessionQuery`、`timer`。
   - Host `Event.listEvents`：`session/event`、`session/created`（均为 emit，
     签名 `(session, event)` / `(session)`）。
   - Host `Builtin.listBuiltins`：`harness`（确认 `handle` 签名）。
   - Client `Builtin.listBuiltins`：`React`、`host`。
   - Client `Slots.listSubTree`：`settings.section`（list/root，选项
     `{id, order, label}`，props `{close}`）、`tool.view.cordis`（key 协议）。
   - Client `Service.listService`：`styles`、`timer`。
3. `cordis_define`：`idPrefix` 建议 `toksta`；`code.host` = 6.1，`code.client` = 6.2。
4. `cordis_run`（mode=`run`）：首次激活；Client 包需要用户在 UI 上批准
   （awaiting-approval → 用户打勾 → starting → 生效）。
5. 生效后：
   - Run 卡片里出现紧凑摘要；
   - 侧边栏「设置」里出现「Token 用量」分区，点开即完整仪表盘；
   - 首次打开时后台扫描历史会话，几秒到几十秒后数据齐全（之后实时更新）。

## 8. 风险、边界与后续增强

**已确认的边界**
- 只统计适配器回报了 usage 的调用；某些 provider 若不回传 usage，该步不计入
  （`assistant/message.usage` 缺失时跳过）。这是数据源的天然边界，不是 bug。
- 连续天数按「当天 0 点前插件必须见证过事件」计算；今天还没用时，当前连续天数
  算到昨天（与 Codex 行为一致）。
- 中断未关闭的 turn（进程崩溃）不计入聊天时长（没有 turn/end）。
- 会话标题类辅助 LLM 调用（`session/title-llm-request`）不写 assistant/message，
  不计入——与 Codex「聊天消耗」口径一致。

**排错指引**
- 页面只有裸文字、热力图/卡片/图例全部消失 → CSS 没注入：`styles` 是 Client **Builtin**，
  不是 ctx Service，`ctx.get('styles')` 返回 undefined。直接调用模块级 `styles.insert(CSS)`。
- `ctx is not defined`（client 渲染崩溃）→ 组件函数里不存在 `ctx`，它只在 `apply(ctx)` 作用域内。
  把 `ctx.interval` 等调用放进 apply 捕获（如模块级 `intervalRef = (cb, ms) => ctx.interval(cb, ms)`），
  组件内经 `startInterval` 之类模块级函数调用（见 6.2 已修正代码）。
- `service "timer" is not declared` → 确认 client 有 timer Service；没有就删掉
  `inject: ['timer']` 和 `ctx.interval`。
- Slot 注册失败 → 用 `Slots.listSubTree` 查到的实时协议核对 `id/key/label` 选项。
- `host.call` 失败 → 检查 Host 的 `harness.handle` 名字一致、插件在运行中。
- 打开设置页没有「Token 用量」→ 看 Run 卡片/`cordis_inspect_self` 的
  `client-render` 诊断。

**后续增强（按需迭代，定义新 Package 后 `cordis_run` mode=update）**
1. **水位线缓存**：把 `sessions` Map（每会话 lastSeq + 聚合值）用 Host `fs`
   Service 写到工作区 `.dsh/token-stats-cache.json`，启动时只折增量，避免全量重扫。
2. **周视图改柱图**、按月筛选、按会话/模型拆分（usage 无模型字段时可用
   `request/header` 事件的 `config.model` 关联）。
3. **会话排行榜**：利用已有的 per-session tokens/chatMs 加一页「Top 会话」。
4. 主题色接入：查询 `Theme.listTokens` 后用 CSS 变量替换硬编码色阶。
