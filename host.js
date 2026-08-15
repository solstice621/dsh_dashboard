// ===== Token 用量统计 · Host 半区（插件 toksta-5）=====
//
// 用法：本文件内容即 cordis_define 的 code.host「函数体」——整段复制粘贴即可，
//       不需要任何包装（无 import/require/TS/JSX）。
// 依赖（部署前用 cordis_inspect_query 核对）：
//   - Host Service：sessionQuery（listSessions / readSession）、sessionPersistence
//     （readFrom 增量读，可选）、fs（快照写盘，可选）、timer（周期 flush，可选）
//   - Host Event：  session/event（emit，(session, event)）、session/created（emit，(session)）
//   - Host Builtin：harness（handle）、console
// 版本：v7（随客户端 v25 一起部署 = pkg-37；v6 = pkg-33）
// v7 变更（「重启不扫盘不重建 · 删除会话保留统计」——按用户要求优化）：
//   1. 聚合状态周期落盘：~/.dsh/storages/token-stats/snapshot.json
//      （fs 服务不支持 ~ 展开，动态插件版用绝对路径；bundle 版用 process.env.HOME）
//   2. 启动优先加载快照 → ready=true 立即出数，随后 sessionPersistence.readFrom(id, lastSeq+1)
//      增量折叠（只处理新增事件，不重放全量；SQLite 后端物理 seek 后缀，不扫盘）
//   3. 无快照 / 格式损坏 / 版本不符 → 回退 v6 全量 backfill（liveFloor + force 补折）
//   4. 已删除会话：快照保留其历史统计，增量同步直接跳过（统计不随删除回退）；
//      想按现存日志重建请用 rescan RPC（或重启后删掉快照文件）
// v6 变更（修复「活跃会话 usage 不可见」——升级/重启后累计数骤降的根因）：
//   竞争：插件启动后，活跃会话的 session/event 实时流先到达（seq 为日志顶端），把该会话
//   lastSeq 推到顶；随后 backfill 的 readSession 全量快照回放时，水位线判断 seq<=lastSeq
//   → 整个回放被跳过 → 只有实时流见过的尾部被统计（如 73 万 vs 真实 1.4 亿）。
//   修复：每会话记录 liveFloor（实时流折叠过的最小 seq）；回放时 force 折叠
//   seq < liveFloor 的头部事件（从未被折叠过），跳过实时流已覆盖的尾部——不重不漏。

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

// 快照文件（动态插件版：绝对路径；fs 服务不展开 ~）
var SNAPSHOT_PATH = '/home/qiuzihan/.dsh/storages/token-stats/snapshot.json'
var SNAPSHOT_VERSION = 1

return {
  apply(ctx) {
    const sessionQuery = ctx.get('sessionQuery')
    const sessionPersistence = ctx.get('sessionPersistence')
    const fs = ctx.get('fs')
    const timer = ctx.get('timer')

    // ---- 自有聚合状态（纯 JSON，不持有 live 对象）----
    const days = new Map()      // dayKey -> {input,output,cacheRead,cacheWrite,total,requests}
    const sessions = new Map()  // sessionId -> {lastSeq,tokens,chatMs,turns,createdAt,model,liveFloor}
    const openTurns = new Map() // sessionId:turn -> startTime
    const modelStats = new Map() // "provider/model" -> {tokens,requests}（request/header 归属）
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
    let dirty = false
    let fsTarget = null

    function sessionRec(id, createdAt) {
      let rec = sessions.get(id)
      if (!rec) {
        rec = {
          lastSeq: -1, tokens: 0, chatMs: 0, turns: 0, createdAt: createdAt || 0,
          model: null, liveFloor: Infinity, // 实时流折叠过的最小 seq（回放头部补折用）
        }
        sessions.set(id, rec)
      }
      return rec
    }

    function markDirty() {
      dirty = true
      // 无 timer 服务时退化为直接写盘（fire-and-forget）
      if (timer === undefined) flushSave()
    }

    function foldEvent(sessionId, event, force) {
      const rec = sessionRec(sessionId)
      if (typeof event.seq === 'number') {
        if (!force && event.seq <= rec.lastSeq) return
        if (event.seq > rec.lastSeq) rec.lastSeq = event.seq
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
        // 模型归属：assistant/message 无 model 字段，用该会话最近一次 request/header 的 provider/model
        const mk = rec.model || 'unknown'
        let ms = modelStats.get(mk)
        if (!ms) {
          ms = { tokens: 0, requests: 0 }
          modelStats.set(mk, ms)
        }
        ms.tokens += t
        ms.requests += 1
        if (t > peakStepTokens) peakStepTokens = t
      } else if (type === 'request/header') {
        // 记录该会话当前使用的 provider/model（供后续 usage 归属）
        const cfg = data.header && data.header.config
        if (cfg && cfg.model) rec.model = (cfg.provider || '?') + '/' + cfg.model
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

    // ---- 快照持久化 ----
    function serialize() {
      const dayList = []
      for (const entry of days) {
        dayList.push({ date: entry[0], input: entry[1].input, output: entry[1].output,
          cacheRead: entry[1].cacheRead, cacheWrite: entry[1].cacheWrite,
          total: entry[1].total, requests: entry[1].requests })
      }
      dayList.sort((a, b) => (a.date < b.date ? -1 : 1))
      const sessList = []
      for (const entry of sessions) {
        sessList.push([entry[0], {
          lastSeq: entry[1].lastSeq, tokens: entry[1].tokens, chatMs: entry[1].chatMs,
          turns: entry[1].turns, createdAt: entry[1].createdAt, model: entry[1].model,
        }])
      }
      const modelList = []
      for (const entry of modelStats) modelList.push([entry[0], entry[1]])
      return JSON.stringify({
        version: SNAPSHOT_VERSION,
        savedAt: Date.now(),
        totalTokens: totalTokens,
        totalRequests: totalRequests,
        peakStepTokens: peakStepTokens,
        longestTurnMs: longestTurnMs,
        longestChatMs: longestChatMs,
        longestChatSessionId: longestChatSessionId,
        days: dayList,
        sessions: sessList,
        modelStats: modelList,
        openTurns: Array.from(openTurns.entries()),
      })
    }

    async function flushSave() {
      if (!dirty || disposed || fs === undefined) return
      dirty = false
      try {
        if (fsTarget === null) fsTarget = await fs.resolve(SNAPSHOT_PATH)
        await fs.writeText(fsTarget, serialize())
      } catch (e) {
        dirty = true // 写失败留脏标记，下个周期重试
        console.error('[dsh-token-usage-dashboard] snapshot write failed:', String(e))
      }
    }

    function loadSnapshot() {
      return fs === undefined ? false : Promise.resolve().then(async () => {
        try {
          const target = await fs.resolve(SNAPSHOT_PATH)
          const text = await fs.readText(target)
          const snap = JSON.parse(text)
          if (!snap || snap.version !== SNAPSHOT_VERSION ||
              !Array.isArray(snap.days) || !Array.isArray(snap.sessions) ||
              typeof snap.totalTokens !== 'number') return false
          fsTarget = target
          for (const d of snap.days) {
            days.set(d.date, { input: d.input || 0, output: d.output || 0,
              cacheRead: d.cacheRead || 0, cacheWrite: d.cacheWrite || 0,
              total: d.total || 0, requests: d.requests || 0 })
          }
          for (const row of snap.sessions) {
            const id = row[0]; const r = row[1]
            sessions.set(id, { lastSeq: r.lastSeq || -1, tokens: r.tokens || 0,
              chatMs: r.chatMs || 0, turns: r.turns || 0, createdAt: r.createdAt || 0,
              model: r.model || null, liveFloor: Infinity })
          }
          for (const row of (snap.modelStats || [])) modelStats.set(row[0], row[1])
          for (const row of (snap.openTurns || [])) openTurns.set(row[0], row[1])
          totalTokens = snap.totalTokens
          totalRequests = snap.totalRequests
          peakStepTokens = snap.peakStepTokens || 0
          longestTurnMs = snap.longestTurnMs || 0
          longestChatMs = snap.longestChatMs || 0
          longestChatSessionId = snap.longestChatSessionId || null
          console.log('[dsh-token-usage-dashboard] snapshot loaded: ' + snap.days.length + ' days, ' +
            sessions.size + ' sessions, total ' + totalTokens)
          return true
        } catch (e) {
          console.log('[dsh-token-usage-dashboard] no usable snapshot, fall back to full scan: ' + String(e))
          return false
        }
      })
    }

    // ---- 快照模式：增量同步（不扫盘、不重建）----
    async function foldDelta(id, fromSeq) {
      try {
        if (sessionPersistence !== undefined) {
          // readFrom：从 fromSeq 起的存储后缀（SQLite 物理 seek，JSONL 至少不重建聚合）
          const res = await sessionPersistence.readFrom(id, fromSeq)
          const events = (res && res.events) || []
          for (let i = 0; i < events.length; i += 1) {
            if (disposed) return
            foldEvent(id, events[i])
          }
        } else {
          // 退化：全量快照 + 水位线跳过已折叠部分（逻辑增量）
          const snap = await sessionQuery.readSession(id)
          const events = (snap && snap.events) || []
          for (let i = 0; i < events.length; i += 1) {
            if (disposed) return
            const ev = events[i]
            if (typeof ev.seq === 'number' && ev.seq < fromSeq) continue
            foldEvent(id, ev)
          }
        }
        scannedSessions += 1
      } catch (e) {
        console.error('[dsh-token-usage-dashboard] incremental read failed:', id, String(e))
      }
    }

    async function syncDelta() {
      if (scanning || disposed) return
      scanning = true
      try {
        const list = sessionPersistence !== undefined
          ? await sessionPersistence.list()
          : await sessionQuery.listSessions()
        const jobs = []
        for (const item of list || []) {
          if (disposed) return
          const header = item && item.header ? item.header : item
          if (!header || !header.id) continue
          const rec = sessions.get(header.id)
          // 快照里已有的会话：只读新增；全新会话：从头读
          const from = rec ? rec.lastSeq + 1 : 0
          if (!rec) sessionRec(header.id, header.createdAt)
          jobs.push(foldDelta(header.id, from))
        }
        await Promise.all(jobs)
        // 快照里有、列表里没有的会话（已删除）：跳过 → 历史统计保留
      } catch (e) {
        console.error('[dsh-token-usage-dashboard] syncDelta failed:', String(e))
      } finally {
        scanning = false
        ready = true
        markDirty() // 同步后落盘一次（水位线推进）
      }
    }

    // ---- 无快照路径：v6 全量 backfill（liveFloor + force 头部补折）----
    async function foldSession(id) {
      const rec = sessionRec(id)
      try {
        const snap = await sessionQuery.readSession(id)
        const events = (snap && snap.events) || []
        for (let i = 0; i < events.length; i += 1) {
          if (disposed) return
          const ev = events[i]
          // 实时流已覆盖尾部（seq >= liveFloor，折叠过且推进了 lastSeq）；
          // 回放只 force 补折头部（seq < liveFloor，实时流从未见过）——不重不漏
          if (typeof ev.seq === 'number' && ev.seq >= rec.liveFloor) continue
          foldEvent(id, ev, true)
        }
        scannedSessions += 1
      } catch (e) {
        console.error('[dsh-token-usage-dashboard] readSession failed:', id, e)
      }
    }

    async function backfill() {
      if (!sessionQuery || scanning) return
      scanning = true
      try {
        const list = await sessionQuery.listSessions()
        // 并发折叠全部会话（水位线去重保证与实时增量不重不漏）
        const jobs = []
        for (const item of list || []) {
          if (disposed) return
          const header = item && item.header
          if (!header || !header.id) continue
          sessionRec(header.id, header.createdAt)
          jobs.push(foldSession(header.id))
        }
        await Promise.all(jobs)
      } catch (e) {
        console.error('[dsh-token-usage-dashboard] listSessions failed:', e)
      } finally {
        scanning = false
        ready = true
        markDirty()
      }
    }

    // 实时增量：水位线保证与增量同步不重复计数；记录 liveFloor 供全量回放头部补折
    ctx.on('session/event', (session, event) => {
      if (!session || !event) return
      const rec = sessionRec(session.id)
      if (typeof event.seq === 'number') {
        rec.liveFloor = Math.min(rec.liveFloor, event.seq)
      }
      foldEvent(session.id, event)
      markDirty()
    })

    // 新出现的会话：seed/恢复的历史不重新 emit，补折一次
    ctx.on('session/created', (session) => {
      if (!sessionQuery || !session) return
      const id = session.id
      sessionRec(id)
      Promise.resolve().then(async () => {
        if (disposed) return
        const rec = sessions.get(id)
        const from = rec && rec.lastSeq >= 0 ? rec.lastSeq + 1 : 0
        await foldDelta(id, from)
        markDirty()
      })
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
      // 洞察类聚合：总轮数 / 聊天总时长 / 输入·输出·缓存 Token
      let totalTurns = 0
      let totalChatMs = 0
      for (const entry of sessions) {
        totalTurns += entry[1].turns
        totalChatMs += entry[1].chatMs
      }
      let totalInput = 0
      let totalOutput = 0
      let totalCacheRead = 0
      for (const entry of days) {
        totalInput += entry[1].input
        totalOutput += entry[1].output
        totalCacheRead += entry[1].cacheRead
      }
      // 模型排名（provider/model，按 token 降序；unknown 归并桶不展示）
      const modelList = []
      for (const entry of modelStats) {
        if (entry[0] === 'unknown') continue
        modelList.push({ key: entry[0], tokens: entry[1].tokens, requests: entry[1].requests })
      }
      modelList.sort((a, b) => b.tokens - a.tokens)
      return {
        ready: ready,
        scanning: scanning,
        scannedSessions: scannedSessions,
        totalTokens: totalTokens,
        totalRequests: totalRequests,
        totalTurns: totalTurns,
        totalChatMs: totalChatMs,
        totalInput: totalInput,
        totalOutput: totalOutput,
        totalCacheRead: totalCacheRead,
        totalSessions: sessions.size,
        activeDays: dayList.length,
        peakDay: peakDay,
        peakStepTokens: peakStepTokens,
        longestTurnMs: longestTurnMs,
        longestChatMs: longestChatMs,
        longestChatSessionId: longestChatSessionId,
        streakCurrent: current,
        streakLongest: longest,
        models: modelList,
        days: dayList,
      }
    }

    const disposers = []
    disposers.push(harness.handle('get-stats', async () => buildPayload()))
    disposers.push(harness.handle('rescan', async () => { await backfill(); return buildPayload() }))

    // 周期 flush：timer 服务可用时 10s 检查一次脏标记
    if (timer !== undefined) {
      const stop = timer.interval(() => { flushSave() }, 10000)
      if (typeof stop === 'function') disposers.push(stop)
    }

    ctx.effect(() => () => {
      disposed = true
      flushSave() // 卸载前尽力落盘（best effort）
      for (const d of disposers) {
        try { d() } catch (e) { /* ignore */ }
      }
    })

    // 启动：优先快照（立即出数 + 增量同步），否则全量回补
    Promise.resolve().then(async () => {
      if (disposed) return
      const ok = await loadSnapshot()
      if (ok) {
        ready = true // 快照即历史真相：直接就绪，不显示扫描占位
        await syncDelta()
      } else {
        await backfill()
      }
    })
  },
}
