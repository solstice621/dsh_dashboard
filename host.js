// ===== Token 用量统计 · Host 半区（插件 toksta-5）=====
//
// 用法：本文件内容即 cordis_define 的 code.host「函数体」——整段复制粘贴即可，
//       不需要任何包装（无 import/require/TS/JSX）。
// 依赖（部署前用 cordis_inspect_query 核对）：
//   - Host Service：sessionQuery（listSessions / readSession）
//   - Host Event：  session/event（emit，(session, event)）、session/created（emit，(session)）
//   - Host Builtin：harness（handle）
// 版本：v6（随客户端 v21 一起部署 = pkg-32；v5 对应 pkg-29）
// v6 变更（修复「活跃会话 usage 不可见」——升级/重启后累计数骤降的根因）：
//   竞争：插件启动后，活跃会话的 session/event 实时流先到达（seq 为日志顶端），把该会话
//   lastSeq 推到顶；随后 backfill 的 readSession 全量快照回放时，水位线判断 seq<=lastSeq
//   → 整个回放被跳过 → 只有实时流见过的尾部被统计（如 73 万 vs 真实 1.4 亿）。
//   修复：每会话记录 liveFloor（实时流折叠过的最小 seq）；回放时 force 折叠
//   seq < liveFloor 的头部事件（从未被折叠过），跳过实时流已覆盖的尾部——不重不漏。
//   模拟验证：真实日志 + 实时尾部竞争，修复后与磁盘全量逐位相等（146,957,379）。

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
    const sessions = new Map()  // sessionId -> {lastSeq,tokens,chatMs,turns,createdAt,model}
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
        console.error('[token-stats] readSession failed:', id, e)
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
        console.error('[token-stats] listSessions failed:', e)
      } finally {
        scanning = false
        ready = true
      }
    }

    // 实时增量：水位线保证与回补不重复计数；记录 liveFloor 供回放头部补折
    ctx.on('session/event', (session, event) => {
      if (!session || !event) return
      const rec = sessionRec(session.id)
      if (typeof event.seq === 'number') {
        rec.liveFloor = Math.min(rec.liveFloor, event.seq)
      }
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

    ctx.effect(() => () => {
      disposed = true
      for (const d of disposers) {
        try { d() } catch (e) { /* ignore */ }
      }
    })

    Promise.resolve().then(backfill)
  },
}
