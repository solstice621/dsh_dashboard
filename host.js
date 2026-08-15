// ===== Token 用量统计 · Host 半区（插件 toksta-5）=====
//
// 用法：本文件内容即 cordis_define 的 code.host「函数体」——整段复制粘贴即可，
//       不需要任何包装（无 import/require/TS/JSX）。
// 依赖（部署前用 cordis_inspect_query 核对）：
//   - Host Service：sessionQuery（listSessions / readSession）
//   - Host Event：  session/event（emit，(session, event)）、session/created（emit，(session)）
//   - Host Builtin：harness（handle）
// 版本：v3（对应运行中的 pkg-11；pkg-9 首版，pkg-10 修 ctx 作用域，pkg-11 修 styles 注入）

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
        console.error('[token-stats] readSession failed:', id, e)
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
        console.error('[token-stats] listSessions failed:', e)
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
