# Token 用量统计插件 — 目标与进度记录

> 记录时间：2026-08-15 21:25 CST（首次）；2026-08-15 深夜（部署完成更新）；2026-08-15（v4 源码迭代，见第五节）
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

---

## 五、v4 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-12` / `run-12`（本 web 会话 cordis_define kind=existing + update 激活）。
> 运行确认：Host/Client 均 running、无诊断错误；`plugin.json` 已回填 `currentPackageId: pkg-12`。
> 部署前唯一风险点已排除：`FitValue` 使用 `React.useRef/useLayoutEffect`，已查 runner 源码
> （dsh-cordis-client-runner 第 170 行 `closure(react, …)`，`require("react")` 全量传入）确认可用。


### 用户反馈（基于运行中的 pkg-11 截图）

1. 热力图方块悬停时应显示当天消耗：「x月x日消耗了 …」；
2. 「每周 / 累计」tab 看不出意义，去掉；
3. 热力图做成分页，一页约一年的量；前一年没有记录则不显示前一年入口；
4. 统计卡数值（xxxx 万 / x 小时 x 分）应自适应在一行以内（截图中「5938.2 万」
   「2 小时 1 分」均换行）；各卡的标签（累计 Token 数等栏目）要在同一高度。

### 改动（仅 `client.js`，`host.js` 不变，无新依赖）

| 需求 | 实现 |
| --- | --- |
| 悬停提示 | 每格内嵌 `<span class="tks-tip">`，纯 CSS `:hover` 显示（不依赖 window/document）；文案「8月15日消耗了 27.3 万 Token · 464 次请求」，无消耗日「8月13日没有 Token 消耗」；容器 `overflow-x:auto` 会裁剪溢出 → 顶部 padding 32px 留位 + 左 8 列/右 2 列提示框贴边对齐；替代原 `title` 属性 |
| 移除 tab | 删除每日/每周/累计三 tab 与 mode 状态，`buildGrid` 不再计算周合计/累计；仅每日视图 |
| 按年分页 | `buildGrid(days, year)` 改为日历年网格：本年页 = 1月1日所在周→今天，往年页 = 完整一年；跨年/未来格 `visibility:hidden`；标题右侧「‹ 前一年 / N 年 / 后一年 ›」；`hasPrev = 最早记录日期 < year-01-01`（无则不显示前一年入口），`hasNext = year < 本年` |
| 数值单行 | 新组件 `FitValue`：`useLayoutEffect` 中先复位 22px 再测 `scrollWidth/clientWidth`，溢出则按比例缩字号（最低 12px）；直接改内联样式不经 React state，无测量-渲染循环；`typeof ResizeObserver` 守卫存在时跟随卡片宽度实时调整 |
| 标签同高 | 卡片改 flex 列布局，数值行 `nowrap` + 固定高 30px（line-height 30px），标签 margin-top 6px 固定 → 各卡标签 y 坐标一致 |

### 验证（本机 node 已跑）

- `new Function` 解析 client.js / host.js：语法 OK；
- `buildGrid` 单测：2026 页 33 列（1月→8月，标签 1月…8月）、2025 页 53 列（标签 1月…12月）、跨年格隐藏正确、max 只取页内可见格；
- `tipText` 有/无消耗两种文案正确。

### 部署步骤（web profile 会话，cordis_* 工具）

1. `cordis_inspect_self(pluginId='toksta-5')` 确认当前运行 pkg-11；
2. `cordis_define`：`plugin.kind='existing'`、`pluginId='toksta-5'`，
   `code.host` = 本仓库 `host.js`（未变，保持两半区同包），`code.client` = 本仓库 `client.js`；
3. `cordis_run` mode=`update` 升级；用户批准后生效；
4. 回填 `plugin.json` 的正式 packageId；
5. 验收：见 `README.md` 验收清单（新增悬停提示、年分页、数值单行、标签同高 4 项）。

---

## 六、v5 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-13` / `run-13`（cordis_define kind=existing + update 激活）。
> 运行确认：Host/Client 均 running、无诊断错误；`plugin.json` 已回填 `currentPackageId: pkg-13`。

### 用户反馈（针对 v4 热力图）

1. v4 当前年份页从 1 月 1 日所在周开始，今天在最后一列的位置随星期几变化（非周六时右下角是隐藏格），
   观感是「今天不在最右下角」；
2. 期望：今天的格子恒在最右下角，左侧起始时间不限（近似一年）。

### 改动（仅 `client.js`，`host.js` 不变）

| 项 | 实现 |
| --- | --- |
| 今天右下角锚定 | `buildGrid(days, colCount=53)` 改为滚动网格：最后一列 = [今天-6 .. 今天]，今天恒为底格（右下角）；向左每列再推 7 天，最左列 ≈ 53 周前（约一年，与参考截图 53 列一致） |
| 移除年分页 | 删除 pager（‹ 前一年 / N 年 / 后一年 ›）、year 状态、`hasPrev/hasNext` 判定；不再从 1 月 1 日开始排格，网格无隐藏格（无跨年/未来格逻辑） |
| 其余不变 | 悬停提示（tips 仍按左 8/右 2 列贴边）、每日视图、FitValue、标签同高 |

### 验证（本机 node，mock 今天=2026-08-15）

- 53 列；最后一列 = 2026-08-09..2026-08-15，底格 = 今天 ✅
- 首列首格 = 2025-08-10（今天-370 天）✅；首列月份标签「8月」✅
- 带数据：max 取全局最大值、今天格/昨天格取值正确 ✅
- `node --check` 语法通过 ✅

---

## 七、v6 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-14` / `run-14`（cordis_define kind=existing + update 激活）。
> 运行确认：Host/Client 均 running、无诊断错误；`plugin.json` 已回填 `currentPackageId: pkg-14`。

### 用户反馈（针对 v5 滚动视图）

1. 底部出现横向拉动条（53 列固定 10px+3px gap ≈ 689px 超容器宽度；月份行 span 13px+3px gap
   pitch=16px 比格子 13px 更宽，进一步撑大滚动宽度）；
2. 月份标签与格子对不上：v5 标签取「该列顶格」的月份，滚动列跨月导致整体偏移
   （如含 8月1日 的列顶格是 7月26日 → 标成 7月，8月 标签偏到下一列）。

### 改动（仅 `client.js`，`host.js` 不变）

| 项 | 实现 |
| --- | --- |
| 月份标签锚定 | 标签挂在「包含该月 1 日」的那一列（GitHub 同款）；网格起点落在月中间时该月不标记（`lastLabelMonth` 从首列首日前一天起算） |
| 月份行同宽 | `.tks-months span{width:var(--tks-size,10px)}`，pitch = 格子宽 + 3px gap，与网格严格同宽 |
| 宽度自适应 | `Heatmap` 用 wrapRef + `useLayoutEffect` 测容器宽，算格子尺寸 `--tks-size`（4~12px 夹逼）直接写内联变量（不经 React state，无渲染循环）；ResizeObserver 守卫跟随变化 |
| 保留 | 列尾 = 今天星期（今天恒在最右下角）、悬停提示、FitValue、标签同高 |

### 验证（本机 node，mock 今天=2026-08-15 周六 / 2026-08-12 周三）

- 两种「今天」下均 53 列、最后一列底格 = 今天 ✅
- 12 个月份标签，逐列校验「含该月 1 日」零错位；首标签 9月（网格始于 2025-08-10，8月 不标）✅
- `node --check` 语法通过 ✅

---

## 八、v7 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-15` / `run-15`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。

### 用户反馈（针对 v6）

1. 「Token 活动」标题与热力图之间空隙过大（12px 标题边距 + 32px 顶部留白 ≈ 44px）；
2. 热力图格子之间空隙过大，希望缩小。

### 改动（仅 `client.js`，纯观感）

| 项 | 改动 |
| --- | --- |
| 标题→热力图间距 | `.tks-activity-head` margin-bottom 12→8px；容器顶部留白 32→22px（合计 44→30px） |
| 提示框配套缩小 | 10px 字号 / line-height 1.45 / padding 2px 6px / bottom 13px → 首行提示高度 ~18.5px，22px 留白足够不被裁剪 |
| 格子空隙 | gap 3→2px（网格横向 `.tks-heatmap`、纵向 `.tks-col`、月份行 `.tks-months`、图例 `.tks-legend`），边缘贴边对齐 -3px→-2px |
| 宽度公式 | `(GRID_COLUMNS-1)*3` → `*2` 同步 |

### 验证（本机 node）

- `node --check` 语法通过；
- 宽度公式抽查：avail 520/560/600/640/700/800/900 → size 7/8/9/10/11/12/12px，总宽均 ≤ avail（不溢出）✅

---

## 九、v8 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-16` / `run-16`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。

### 用户反馈（针对 v7）

1. 格子空隙再小 1px（2px→1px）；
2. 热力图右缘与上方统计卡不对齐（内容左对齐、右侧留白），希望左右对齐或居中。

### 改动（仅 `client.js`，纯观感）

| 项 | 改动 |
| --- | --- |
| 空隙 1px | 网格横向/纵向、月份行、图例 gap 2→1px；边缘贴边 -2px→-1px；宽度公式 `(GRID_COLUMNS-1)*1` |
| 水平居中 | `.tks-heatmap-wrap` 改 flex column + `align-items:safe center`：内容窄于容器时整体居中；`safe` 保证极端窄容器回退左对齐不丢内容 |
| 对齐策略 | 格子尺寸在 4~12px 内取最大整像素 → 常见面板宽度（≤692px）下总宽≈容器宽，与统计卡左右对齐；超出 12px 上限的余量左右居中 |

### 验证（本机 node）

- `node --check` 语法通过；
- 宽度抽查（gap=1）：avail 520→8px/余40、560→9/27、600→10/14、640→11/1、700→12/8、800→12/108、960→12/268，均不溢出，余量居中 ✅

---

## 十、v9 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-17` / `run-17`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。

### 用户反馈（针对 v8）

1. 底部有时闪现横向滚动条，需排查；
2. 希望格子间距调成 0、大小适度增加，并做成自适应界面大小的机制。

### 滚动条闪现根因排查结论

1. **月份标签文字溢出**（主因）：`.tks-months span` 是 nowrap 且 `overflow:visible`，
   「10月」等标签（≈20px）宽过列距（10~12px），文字溢出使月份行 scrollable overflow
   超过容器 clientWidth —— 在特定宽度/格子尺寸组合（如格子 11px、容器 ≈640px 时只差 1~4px）
   滚动条出现，宽度一变又消失 → 「闪现」。
2. **resize 一帧滞后**：窗口/面板尺寸变化时 ResizeObserver 回调在下一帧才修正格子尺寸，
   中间一帧旧尺寸超宽 → 滚动条闪一下。

### 修复与改动（仅 `client.js`）

| 项 | 改动 |
| --- | --- |
| 根治闪现 | 容器 `overflow-x:hidden`（fit 稳态必不溢出，滚动条无存在必要）；月份行 `overflow:hidden`（标签文字不再撑大 scrollable overflow） |
| gap 归零 | 网格横向/纵向、月份行 gap:0；图例保留 2px（可读性）；提示框边缘贴边 0 |
| 尺寸增大 | 上限 12→14px，`size=(avail-4)/53` 精确填充（640px→12px、746px→14px 恰好满宽） |
| 自适应机制 | 保持：`useLayoutEffect` 测容器宽（绘制前执行，无首帧闪烁）→ 写 `--tks-size` CSS 变量 → `ResizeObserver`（typeof 守卫）跟随窗口/面板变化；`align-items:safe center` 居中余量 |

### 验证（本机 node）

- `node --check` 语法通过；
- 宽度抽查（gap=0，cap=14）：400→7/余25、500→9/19、560→10/26、600→11/13、640→12/**余0 精确对齐**、
  700→13/7、746→14/**余0**、800→14/54、960→14/214、1200→14/454 —— 全部不溢出 ✅

---

## 十一、v10 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-18` / `run-18`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。

### 用户反馈（针对 v9）

1. 标签文字溢出无所谓（保持现状即可）；
2. 格子空隙换回一些（v9 的 gap:0 太密）→ 改为 2px。

### 改动（仅 `client.js`，观感微调）

- 网格横向/纵向 gap 0→2px；月份行 gap 0→2px（pitch = 格子宽 + 2px，与网格同宽）；图例不变（2px）；
- 宽度公式 `(avail - 4 - 52*2)/53` 同步；提示框边缘贴边 -2px；
- 滚动条根治（容器/月份行 overflow:hidden）与自适应机制保持不变。

### 验证（本机 node）

- `node --check` 语法通过；
- 宽度抽查（gap=2，cap=14）：400→5px/余27、600→9/15、640→10/2、746→12/2、800→13/3、960→14/110 —— 全部不溢出 ✅

---

## 十二、v11 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-19` / `run-19`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。

### 用户反馈（针对 v10）

1. 月份标签加上年份（跨年视图需要区分 2025/2026）；
2. 格子再大一点、间隙缩为 1px。

### 改动（仅 `client.js`，观感微调）

| 项 | 改动 |
| --- | --- |
| 年份标签 | 标签格式「2026年8月」：`Math.floor(m/12)+'年'+((m%12)+1)+'月'`；网格首标签「2025年9月」、末标签「2026年8月」（mock 今天=2026-08-15 单测通过） |
| 格子 | gap 2→1px（网格横向/纵向、月份行），尺寸上限 14→16px，宽度公式 `(avail-4-52)/53` 同步，提示框贴边 -1px |

### 验证（本机 node）

- `node --check` 语法通过；
- 年份标签单测：12 个标签、首「2025年9月」、末「2026年8月」✅；
- 宽度抽查（gap=1，cap=16）：400→6px、640→11（余1）、746→13（余1）、800→14（余2）、960→16（余56）、1200→16 —— 全部不溢出 ✅

---

## 十三、v12 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-20` / `run-20`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。

### 用户反馈（针对 v11）

悬停提示（指针放在格子上显示的日期）目前是「月日」，改为「年月日」。

### 改动（仅 `client.js`）

`tipText` 头部加年份：「2026年8月15日消耗了 27.3 万 Token · 34 次请求」/「2025年9月1日没有 Token 消耗」（底部月份轴标签不变，仍为「2026年8月」）。

### 验证（本机 node）

- `node --check` 语法通过；
- `tipText` 单测：有消耗「2026年8月15日消耗了 27.3 万 Token · 34 次请求」、无消耗「2025年9月1日没有 Token 消耗」✅

---

## 十四、v13 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-21` / `run-21`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。

### 用户反馈（针对 v12）

1. 底部月份标签去掉年份（恢复「8月」）；
2. 新增「每周」栏目：7 格高/列，格子自下而上展现用量；用量最大的列全满，其他按比例填整数格，颜色统一。

### 改动（仅 `client.js`）

| 项 | 实现 |
| --- | --- |
| 标签去年份 | `label = (m%12)+1 + '月'`（悬停提示的年月日保留） |
| 每周用量栏目 | 每日热力图正下方新增 53 列 × 7 格柱状条（`.tks-weekly`，pitch 与热力图完全一致，天然对齐）；每列 = 一周总用量，底格索引 6 自下而上填充：`filled = round(7 * 周用量 / 最大周用量)`，有量至少 1 格、最大周 7 格全满，无量 0 格（灰格占位）；统一颜色 `#e5764c`（`.tks-week-full`）；每个格子带原生 title「周起始 ~ 周结束 所在周 · X Token」；上方加小标题「每周用量」 |

### 验证（本机 node）

- `node --check` 语法通过；
- 标签恢复「9月 … 8月」无年份 ✅；
- 填充比例单测：周用量 100/50/25/0/200（max=200）→ 满格 4/2/1/0/7，最大周 7 格全满 ✅

---

## 十五、v14 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-22` / `run-22`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。

### 用户反馈（针对 v13）

1. 「每周用量」不要常驻下方栏目，改为热力图右上方一个按钮，切换 每日/每周 两种视图；
2. 每周视图格子悬停时也要能查看用量。

### 改动（仅 `client.js`）

| 项 | 实现 |
| --- | --- |
| 视图切换 | `.tks-activity-head` 右侧新增「每日 / 每周」两个 tab 按钮（`.tks-tab`，选中下划线）；Dashboard 增加 `view` state，默认 daily |
| 每周视图 | `view==='weekly'` 时渲染 53 列 × 7 格柱状条（自下而上填充、最大周全满、按比例整数格、统一 `#e5764c`），月份行共用；每日视图图例仅在 daily 显示 |
| 每周悬停提示 | 每周每格内嵌 `.tks-tip` 气泡（与每日同款交互）：「2026年8月9日 ~ 2026年8月15日 所在周消耗了 27.3 万 Token」；左 8/右 2 列贴边防裁剪 |

### 验证（本机 node）

- `node --check` 语法通过；
- `tipText` / `weekTipText` 单测：每日「2026年8月15日消耗了 27.3 万 Token · 34 次请求」、
  每周「2026年8月9日 ~ 2026年8月15日 所在周消耗了 27.3 万 Token」✅

---

## 十六、v15 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-23` / `run-23`（**host v4 + client v15 同包**，cordis_define kind=existing + update 激活）；
> `plugin.json` 已回填。这是首次 Host 代码变更（v1 起 host 未动）。

### 用户反馈

热力图下方新增平行排列的两个栏目：左侧「洞察」（有趣的小数据，如聊天总数等），
右侧「最喜欢的模型」（供应商-模型 的 token 用量排名）。

### Host v4 变更（host.js）

| 项 | 实现 |
| --- | --- |
| 模型归属 | `assistant/message` 不带 model（实测确认），改折 `request/header` 的 `data.header.config.provider+model` 记录到会话（`rec.model`），后续 usage 归入 `modelStats`；unknown 桶不展示 |
| 洞察聚合 | `buildPayload` 新增 `totalTurns`（turn/end 数）、`totalChatMs`、`totalInput`、`totalOutput`、`totalCacheRead`、`models[]`（provider/model 按 token 降序） |

### Client v15 变更（client.js）

- 热力图下方新增 `.tks-insights-row` 平行两栏：
  - **洞察**：聊天总数（轮）、LLM 请求数、会话总数、活跃天数、缓存命中率（cacheRead/总消耗）、平均每轮 Token、平均每轮时长；
  - **最喜欢的模型**：Top5 provider/model 排名（序号 + 名称省略号截断 + token 量 + 比例条，最大 100% 最小 2%），空数据显示「暂无模型数据」；
- 两栏为带边框圆角面板，`flex:1` 等宽。

### 验证（本机 node，端到端）

- 用 11 个真实会话日志全量喂入新 host 折叠逻辑：totalTokens=123,248,990、totalRequests=734、
  totalTurns=70、totalChatMs≈5h、缓存命中率 98%、无错误日志；
- 模型排名归因正确：`deepseek-official/deepseek-v4-flash` 8816万 → `opencode-go/deepseek-v4-pro` 3221万
  → `opencode-go/kimi-k3` 275万 → `opencode-go/deepseek-v4-flash` 11万 ✅

---

## 十七、v16 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-24` / `run-24`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。

### 用户反馈（针对 v15）

热力图下面的「少 □□□□□ 多」颜色图例可以删除。

### 改动（仅 `client.js`）

- 移除 Heatmap 渲染中的图例元素（`少 + lv0..lv4 + 多`）；
- 移除 `.tks-legend` CSS 规则；`grep` 确认 `tks-legend` 零残留；
- `node --check` 语法通过。

---

## 十八、v17 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-25` / `run-25`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。

### 用户反馈（针对 v16）

右上角「重新扫描」按钮是否有必要？

### 结论与改动（仅 `client.js`）

- **结论**：日常不需要。数据有三重保障：① `session/event` 实时折叠（新对话即时入账）；
  ② 30s 自动刷新（纯内存组装）；③ 启动回补 + `session/created` 补折。rescan 仅对
  「日志被外部工具改动/重放导致水位线漏折」的罕见场景有意义。
- **改动**：删除右上角「重新扫描」按钮及 `.tks-btn` CSS（修复了删除时误删闭合括号的问题）；
  Host 的 `rescan` RPC **保留**备用（排查时仍可调用）。

---

## 十九、v18 迭代（2026-08-15）✅ 已部署

> 部署完成：`pkg-26` / `run-26`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。

### 用户反馈

「Token 用量」改为「统计」。

### 改动（仅 `client.js`）

- 设置页入口 label：`'Token 用量'` → `'统计'`；
- 页面标题：`'Token 用量'` → `'统计'`；
- Run 卡片：`'Token 用量：'` → `'统计：'`，「设置 → Token 用量」→「设置 → 统计」。

---

## 二十、bundle 打包（2026-08-15）✅ 可安装包完成

> 目标：加入 GitHub dsh 生态（第②步：打包成可安装插件）。

### 产物（仓库根目录即 npm 包 `dsh-token-stats`）

| 文件 | 说明 |
| --- | --- |
| `package.json` | `type: module`；`main: lib/index.js`；exports `.`/`./client`；`dsh.bundle.patch` → `cordis.patch.yml`；`dsh.client { inject: [client-runtime, ui-slots, ui-settings-general], platform: web }`（参考 Make0209/dsh-usage-stats 官方社区格式） |
| `cordis.patch.yml` | `- insert: - { id: token-stats, name: dsh-token-stats }` |
| `lib/index.js` | Host：与动态版 host.js 同源折叠逻辑；数据出口改为 `webServer.register({kind:'exact', path, handler})`（`GET /api/token-stats`、`POST /api/token-stats/rescan`），不依赖 harness RPC |
| `lib/client.js` | Client：`window.__ModuleLoader__.load({id, factory})` 工厂；`exports.inject=['timer']`、`apply(ctx)` 注册「设置 → 统计」；数据用 `fetch('/api/token-stats')`；样式经 `<style>` 注入并随 dispose 移除；去掉动态版专属的 tool.view.cordis RunCard |

### 验证（本机）

1. `node --check` 两端通过；
2. **host 端到端**：ESM 导入 `lib/index.js`，假 ctx + 真实会话日志喂入 → 路由 `/api/token-stats` 返回 200，
   totalTokens=152,048,419 / turns=75 / 4 个模型（Top：deepseek-official/deepseek-v4-flash）✅；
3. **client 工厂冒烟**：stub window/document 执行 factory → `exports.inject=['timer']`、`apply` 为函数 ✅；
4. **真实安装**：`corepack enable pnpm`（pnpm 11.21.0）→ `dsh plugin --profile headless add file:...` 成功，
   `dsh.profile.bundles` 出现 `dsh-token-stats`，`--dump-config` 合成配置正确插入插件行；测试后已 remove 还原 ✅。

### 下一步（用户可选项）

- 第①步 Topics 标签（手动 30 秒或 PAT）；
- 第③步 awesome-dsh-plugin PR（打包已完成，PR 材料随时可备）；
- 第④步市场自动收录（①+② 完成后自动）。

### 第二十节补充（Topics 已加）

- 用户已在 GitHub 仓库页添加 Topics 并确认；抓取页面验证 7 个 topic 全部生效：
  `dsh-plugin`、`deepseek-harness`、`dsh`、`cordis-plugin`、`token-usage`、`usage-stats`、`dashboard` ✅
- README 重写为生态导向：安装（bundle）置顶、功能/验收/排错/边界/生态章节、徽章；
  新增 MIT LICENSE（package.json 与徽章引用）。

---

## 二十一、v19 i18n + README 双语（2026-08-15）✅ 已部署

> 动态版部署：`pkg-27` / `run-27`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。
> bundle 版 `lib/client.js` 同步移植 i18n（同源代码），随仓库推送。

### 用户需求

做英文适配（README + 插件本身）：插件界面跟随 DSH 语言设置——中文环境显示中文仪表盘，
其他语言显示英文仪表盘。

### 实现（client.js / lib/client.js，i18n）

| 项 | 实现 |
| --- | --- |
| 语言检测 | Client `locale` Service（经 `cordis_inspect_query` 核实契约）：`getLocale().active ∈ ['zh','en']`；`subscribe(fn)` 监听切换 |
| 文案字典 | `DICT = { zh, en }`（约 40 键：标题/副标题/统计卡/热力图提示/洞察/模型栏/加载态…）；`t(key)` / `tf(key, vars)` 带占位符格式化 |
| 跟随切换 | `apply` 读取初始 locale + `ctx.effect(() => locale.subscribe(...))` 更新 `activeLang` 并触发 `i18nListeners`；组件 `useT()` 订阅强制重渲染 |
| 数值格式 | zh：亿/万（1.2 亿）；en：B/M/k（123.2M / 273k） |
| 时长格式 | zh：X 小时 Y 分；en：7h 20m / 54m / 45s |
| 日期/月份 | zh：2026年8月15日 / 8月；en：Aug 15, 2026 / Aug（月份轴与悬停提示同源） |
| 设置页 label | `() => t('title')`：zh「统计」/ en「Stats」，随语言即时变 |

### 验证（本机 node）

- `node --check`（CJS 模式，因 package.json `type: module` 需 `--input-type=commonjs`）通过；
- i18n 纯函数双语断言全部正确（zh/en 各 8 项：数值/时长/日期/提示/周提示/标题/副标题/RunCard）；
- 月份标签：zh「8月」/ en「Aug」✅；
- bundle client 工厂冒烟通过（exports.inject=['timer']、apply 为函数）。

### README 双语

- `README.md` → 英文版（生态导向，含语言切换行 English | 简体中文）；
- `README.zh.md` → 中文版（原内容 + i18n 特性 + 验收项）；
- 两版互相链接；截图、徽章、安装/部署/排错/边界/生态章节一致。

---

## 二十二、v20 修复英文残留（2026-08-15）✅ 已部署

> 部署完成：`pkg-28` / `run-28`（cordis_define kind=existing + update 激活）；`plugin.json` 已回填。
> bundle 版 `lib/client.js` 同步修复。

### 用户反馈（切英文后）

1. 设置面板名字仍显示「统计」；
2. 连续天数显示「1天」（应为英文）。

### 根因与修复（仅 client.js）

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| 面板名不切换 | shell 的 settings 列表用 `useSyncExternalStore`：locale 变化时**同步重渲染**并重新调用 `label()`，早于我们的 `locale.subscribe` 回调（此时 `activeLang` 还是 'zh'）→ 解析出「统计」且快照已缓存 | label 改为调用时**直接读 `locale.getLocale()` 快照**（`snap.active === 'zh' ? '统计' : 'Stats'`），免疫回调时序 |
| 天数不切换 | `data.streakCurrent + ' 天'` 硬编码中文，漏 i18n | 改用 `tf('valDays', { n })`（en 无后缀 / zh「N 天」） |
| RunCard 冒号 | `t('title') + '：'` 全角冒号在英文下不协调 | 按语言：en `': '` / zh `'：'` |

### 验证（本机 node）

- 语法通过（动态 CJS 模式 / bundle ESM）；
- `tf('valDays', {n:1})`：en → `1`、zh → `1 天` ✅；
- label 读快照逻辑：snapshot.en → `Stats`、snapshot.zh → `统计` ✅。

---

## 二十三、v21 修复「升级后累计数跳变」（2026-08-15）✅ 已部署

> 部署完成：`pkg-29` / `run-29`（host v5 + client v21，cordis_define kind=existing + update 激活）；
> `plugin.json` 已回填。bundle 版 lib/index.js、lib/client.js 同步修复。

### 调查结论（详见对话）

- 数据无丢失：全量折叠 12 会话 = 204,826,900 Token（908 请求），无 compaction、日志完整；
- 链路逐项排除：listSessions 全目录、readSession 全量（live 会话内存 log 只追加不裁剪）、水位线不重不漏；
- 真因：每次 `cordis_run update` 重启 Host 半区 → 内存聚合清零 → 逐会话异步回补；
  回补完成前 `get-stats` 返回**部分累计** → 面板/Run 卡片显示"跳水"数字。

### 修复（host v5 + client v21）

| 端 | 改动 |
| --- | --- |
| Host | backfill 并行化：`Promise.all` 并发折叠全部会话（原逐会话 await，窗口几十秒→约 2s） |
| Client | 扫描期间不显示部分数字：`data.scanning && !data.ready` 时显示「正在扫描历史会话（x/y）…」占位页（RunCard 显示「加载中…」）；轮询间隔自适应 2s（扫描中）/ 30s（就绪），扫描结束即呈现完整数字 |

### 验证

- `node --check` 全部通过（动态 CJS / bundle ESM）；
- bundle host 并行折叠端到端：真实日志并发喂入 → 路由返回 200，totalTokens 213M+（日志持续增长中）、
  水位线去重正确、无重复计数 ✅。

---

## 二十四、v22/v23 修复「活跃会话 usage 不可见」（2026-08-15）✅ 已部署

> 正式版部署：`pkg-33` / `run-33`（host v6 + client v21，无调试路由）；`plugin.json` 已回填。
> 验证版：`pkg-32` / `run-32`（临时 host-only + /api/token-stats-debug 调试路由）。

### 用户反馈

设置面板出现自相矛盾数据：累计 558.8 万，但峰值日 8291 万（> 累计）；怀疑随版本迭代总量下降。

### 调查过程（全部有实证）

1. **磁盘基准**：全量折叠 12 会话 = 204,826,900（后增长至 239,570,215）；无 compaction、日志完整；
2. **链路排查**：listSessions 全目录、readSession 全量（live 会话内存 log 只追加不裁剪）、水位线不重不漏——结构上无缺陷；
3. **调试路由取证**（pkg-30/31 临时路由 + curl 直读运行态）：
   - 插件状态内部自洽（Σdays == totalTokens == 83,633,769），但 **session-6fb13e（当前活跃会话）tokens=73 万、lastSeq=533,494（已到日志顶端）**；
   - 其他会话与磁盘逐位精确匹配 → **只有活跃会话的历史缺失**；
   - 两个读取路径（readSession / inspect）事件数一致，排除读取裁剪。

### 根因

**水位线竞争**：插件（重新）启动后，活跃会话的 `session/event` 实时流先到达新事件（seq 为日志顶端 ~53 万），
把该会话 `lastSeq` 推到顶；随后 backfill 的 `readSession` 全量快照（1..53 万）回放时，
`seq <= lastSeq` 判定使**整个回放被跳过** → 只有实时流见过的尾部被统计（73 万），
头部 1.4 亿历史永久不可见。每次升级都触发一次 → 「总量下降」。

### 修复（host v6）

- 每会话记录 `liveFloor`（实时流折叠过的最小 seq）；
- 回放时跳过 `seq >= liveFloor`（实时流已覆盖），对 `seq < liveFloor` 的头部事件 **force 补折**（从未被折叠过）——不重不漏；
- 模拟验证（真实日志 + 实时尾部竞争）：修复后与磁盘全量**逐位相等**（146,957,379）；
- **线上验证**：pkg-32 部署后 curl 直读——累计 83,633,769 → **243,375,726**；峰值日 8/15 = 194,818,371 与磁盘基准**逐位相等**；活跃会话 73 万 → 1.6 亿；turns 50 → 84。

### bundle 版同步

`lib/index.js` 已同步 v6 修复（liveFloor + force），随仓库推送。
