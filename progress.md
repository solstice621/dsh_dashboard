# Token 用量统计插件 — 目标与进度记录

> 记录时间：2026-08-15 21:25 CST（首次）；2026-08-15 深夜（部署完成更新）
> 关联文档：`~/token-stats-plugin-plan.md`（完整策划 + 可部署代码）
> 状态：**已部署并运行中** ✅（见下方「部署记录」）；源码已归档至 git 仓库 `~/dsh-dashboard`（main @ 64a88fc，远程 `git@github.com:solstice621/dsh_dashboard.git`）

---

## 一、一开始的目标（原始需求）

用户看到一张 **Codex 个人用量主页**的截图，提出：

1. 做一个 **DeepSeek Harness（dsh）插件**，实现类似 Codex 的 Token 使用情况记录与展示效果；
2. 仔细观察并**详细描述图片**，使之后没有视觉功能的模型也能理解要做什么；
3. **仔细策划**怎么做、如何实现。

### 参考图片的完整文字描述（已存档于 plan 第 1 节）

Codex 网页端个人主页，浅色主题、中文界面，三段式：

- **头部（居中）**：圆形头像（粉发动漫女孩，约 96px）→ 显示名「爱弥斯」（大号粗体）→ 灰色 handle `@qiuzihan32` + 圆角描边「Pro」徽章。
- **统计卡片行**（一行 5 格等宽、格间细分隔线，上大数值下小灰标）：
  | 数值 | 标签 |
  | --- | --- |
  | 115.9亿 | 累计 Token 数 |
  | 5.3亿 | 峰值 Token 数 |
  | 7 小时 20 分 | 最长聊天时长 |
  | 12 天 | 当前连续天数 |
  | 19 天 | 最长连续天数 |
- **Token 活动区**：左侧标题「Token 活动」，右侧 tab「每日（选中）/每周/累计」；主体为 GitHub 贡献图风格热力图——53 列 × 7 行圆角小方块（列=周、格=天），色阶浅灰→浅鲑鱼粉→深橙红，底部月份轴 9月→8月（滚动 12 个月）。图中 6 月起活动增多，7~8 月最密集。

---

## 二、当前成果

### 1. 完成 harness 源码调研（全部有本机证据，非猜测）

| 发现 | 证据位置 |
| --- | --- |
| 会话日志持久化为多 zstd frame 拼接的 jsonl；Node 22 的 `zlib.zstdDecompressSync` 逐帧解压可读（本机无 zstd CLI/无 pip，Node 唯一可行路径） | `~/.dsh/sessions/<cwd编码>/<sessionId>/session.jsonl.zstd` |
| **usage 数据记录在 `assistant/message` 事件的 `data.usage`**（每步一条，与消息同行，无独立 usage 记录） | `dsh-session/lib/types/types.d.ts`（`assistant/message` 条目注释）+ 实测日志行 |
| `TokenUsage = {inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?}`，**计数互斥**：总消耗=前四项之和；reasoningTokens 是 output 子集不另加 | `dsh-llm/lib/types/types.d.ts` |
| 时长数据：`turn/start {turn}` / `turn/end {turn, reason}` | 同上 types.d.ts |
| **历史回补通道**：`ctx.sessionQuery`（`listSessions()` → header 列表；`readSession(id)` → 完整事件日志），`session-query-sqlite` 已在 dsh-base bundle 挂载 | `dsh-session-query/lib/types/*.d.ts`；`dsh-base/cordis.patch.yml:117` |
| **实时增量通道**：Host 事件 `session/event`（每次日志追加触发）、`session/created`（seed/恢复的历史不重新 emit，需 readSession 补折） | `dsh-session/lib/types/index.d.ts` Events 声明 |
| 会话投影缝隙 `sessionProjections`（init/apply/view 单元）存在但本次未采用（它是 per-session 的，本插件要全局聚合，直接监听事件更简单） | `dsh-session-projection/lib/types/index.d.ts` |
| `sessionStats` 官方投影只统计 turn/step 数与墙钟时间，**不含 token 数** → 证实需要自建折叠 | `dsh-session-stats/lib/types/types.d.ts` |
| `dsh-token-meter` 是上下文压力测量服务（context window pressure），**不是**累计用量统计 → 不适用 | `dsh-token-meter` package.json 描述 |
| **UI 落点**：`settings.section` Slot（list/root，选项 `{id, order, label}`，label 支持字符串或函数，组件收 `{close}`）；`tool.view.cordis`（`key:'self'` → Run 卡片）；`styles.insert(css)` | `dsh-client-ui-settings-general/lib/client.js`；`dsh-client-ui-slots/lib/index.js`（`resolveSlotLabel`） |
| Host⇄Client 通信：`harness.handle(method, handler)` / `host.call(method, args)`，仅无损 JSON | cordis-plugin-development 技能文档 |
| **cordis_* 工具只在 web profile 挂载**（cordis-host-runner / cordis-client-runner / ui-cordis）；当前 CLI 会话无这些工具 → 部署必须在浏览器会话进行 | `dsh-web-app/cordis.patch.yml:102,171,205` |
| 持久化备选：`ctx.storage.domain`（schema 校验 KV，workspace.json 同机制）需 zod，动态插件 import 受限 → 首版不采用；`fs` Service 可做工作区内 JSON 缓存 | `dsh-storage-domain/lib/types/*.d.ts` |

### 2. 完成指标口径定义（6 项关键决策）

| 指标 | 口径 | 决策依据 |
| --- | --- | --- |
| 累计 Token 数 | 全部会话 `assistant/message` usage 四项之和 | 与 Codex 一致 |
| 峰值 Token 数 | **单日**总量最大值（附单次请求峰值） | 5.3亿/115.9亿≈4.6%，比例只可能是日峰值 |
| 最长聊天时长 | 单会话 turn 墙钟之和的跨会话最大值（附最长单轮） | 「聊天」对应一个会话 |
| 当前/最长连续天数 | 有消耗日期集合的连续段；今天未用则算到昨天 | 与 Codex 行为一致 |
| 热力图 | 本地时区日粒度；每日/每周（列内 7 天总和）/累计三模式 | 复刻截图三 tab |
| 统计范围 | 全部会话含子代理；每次 LLM 调用记 1 请求 | 用户级全局口径 |

### 3. 完成架构设计

- **Host**：启动时 `sessionQuery.listSessions + readSession` 全量回补（异步后台）→ `ctx.on('session/event')` 实时折叠 → `session/created` 补折 seed；每会话 seq 水位线去重；状态为纯 JSON 的 Map（日粒度桶 + 会话表 + 全局计数）；`harness.handle('get-stats'/'rescan')` 供数。
- **Client**：`settings.section(id='token-stats')` 渲染完整仪表盘（5 卡片 + 三 tab 热力图 + 图例 + 刷新）；`tool.view.cordis(key='self')` 渲染 Run 卡片紧凑摘要；30s 定时刷新 + 手动重扫。
- **不做独立持久化**：会话日志即事实源，重启重折即恢复（后续可加水位线缓存优化）。

### 4. 完成可直接部署的完整代码

见 `~/token-stats-plugin-plan.md` 第 6 节：
- 6.1 `code.host`（约 180 行：折叠器 + 回补 + 实时监听 + 连击/峰值/时长推导 + 2 个 RPC）
- 6.2 `code.client`（约 200 行：Dashboard/Heatmap/StatCard/RunCard 组件 + 全部 CSS，纯 `React.createElement`，无 JSX/import）

### 5. 完成部署手册与风险清单

plan 第 7 节（web 会话中的 inspect→define→run 逐步流程、idPrefix 建议 `toksta`、审批说明）与第 8 节（4 条已确认边界、4 条排错指引、4 项后续增强：水位线缓存/按模型拆分/Top 会话榜/主题色接入）。

---

## 三、部署记录（2026-08-15 深夜，web 会话完成）

- **插件**：`toksta-5`「Token 用量统计（Codex 风格）」；**当前 Package**：`pkg-11`（v3）；**当前 Run**：`run-11`。
- **部署流程**：cordis_inspect_list → 实时核对契约（全部与 plan 第 7 节预期一致）→ cordis_define（idPrefix=`toksta`）→ cordis_run 由用户在 UI 批准 → 运行成功。
- **v2（pkg-10 / run-10）故障与修复（pkg-11 / run-11，mode=update）**：
  - 故障：仪表盘能渲染，但**全是裸文字**——统计卡、热力图、图例方块全部无样式。
  - 根因：plan 代码用 `ctx.get('styles')` 取样式服务，但 Client 的 `styles` 是 **Builtin**
    （模块级全局 `styles.insert(css)`），Service 目录里没有它 → 返回 undefined → CSS 从未注入。
  - 修复：`apply(ctx)` 里直接调用 `styles.insert(CSS)`（builtin）；已同步修正 plan 文档
    §2.3 调研结论、§6.2 代码与排错指引。
  - 验收：update 成功，Host/Client 均 running、无诊断错误。
- **与 plan 代码的差异汇总**（均已同步到运行版本与 plan 文档）：
  1. `console.warn` → `console.error`（Host builtin 只有 log/error，warn 缺失会在 catch 分支抛错）；
  2. `harness.handle` 返回的 disposer 收进数组，在 `ctx.effect` 清理时释放（stop/update 时彻底移除 RPC）；
  3. Client 组件内不直接引用 `ctx`，timer interval 经 apply 捕获的模块级桥调用（v2 修复）；
  4. Client 样式不走 `ctx.get('styles')`，直接调用 builtin `styles.insert(CSS)`（v3 修复）。

---

## 四、当前状态与下一步

**状态**：✅ 图片描述 ✅ 源码调研 ✅ 口径定义 ✅ 架构设计 ✅ 完整代码 ✅ 部署手册 ✅ **已部署运行**
**预期效果**：Run 卡片有紧凑摘要；侧边栏「设置 → Token 用量」有完整仪表盘（5 统计卡 + 每日/每周/累计热力图 + 重新扫描）；后台已自动扫描全部历史会话，之后实时增量。

**下一步（可选）**：
1. 打开「设置 → Token 用量」验收 UI 与数值；
2. 按 plan 第 8 节迭代增强（水位线缓存 / 按模型拆分 / Top 会话榜 / 主题色），定义新 Package 后 `cordis_run` mode=`update` 升级；
3. 不再需要时 `cordis_stop` 或 `cordis_undefine` 移除。

**部署后期望效果**：Run 卡片出现紧凑摘要；设置页新增「Token 用量」分区，内含 5 统计卡 + 每日/每周/累计热力图；首次打开后台扫描全部历史会话（秒级~几十秒），之后实时更新。
