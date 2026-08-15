# Token 用量统计（Codex 风格）— dsh 动态 Cordis 插件

为 DeepSeek Harness（dsh）Web UI 提供 Codex 个人主页风格的 Token 用量统计：

- **5 统计卡**：累计 Token 数 / 峰值 Token 数（单日）/ 最长聊天时长 / 当前连续天数 / 最长连续天数；数值自适应收缩字号保证单行，各卡标签同高
- **热力图**：GitHub 贡献图风格，53 列 × 7 行滚动视图（最后一列以今天结尾，今天恒在最右下角，最左约一年前）；悬停方块显示「x月x日消耗了 xx Token · N 次请求」
- **数据源**：全部会话日志（`assistant/message` 事件的 `data.usage` + `turn/start`/`turn/end`），无需独立持久化

## 文件

| 文件 | 说明 |
| --- | --- |
| `host.js` | Host 半区（折叠器 + 回补 + 实时监听 + `get-stats`/`rescan` RPC）——内容即 `cordis_define` 的 `code.host` 函数体 |
| `client.js` | Client 半区（仪表盘 + Run 卡片 + 样式）——内容即 `cordis_define` 的 `code.client` 函数体 |
| `plugin.json` | 插件元信息与版本历史 |
| `plan.md` | 完整策划文档（参考截图描述、接口调研、口径定义、架构、部署手册、排错） |
| `progress.md` | 目标与进度档案（含部署/故障/修复记录） |

## 部署步骤（需在 web profile 会话中，该会话挂载 `cordis_*` 工具）

1. `cordis_inspect_list` 获取 Provider 目录；
2. `cordis_inspect_query` 核对契约（如与运行环境不符，以实时结果为准）：
   - Host `Service.listService`：`sessionQuery`（`listSessions`/`readSession`）；
   - Host `Event.listEvents`：`session/event`（emit，`(session, event)`）、`session/created`（emit，`(session)`）；
   - Host `Builtin.listBuiltins`：`harness`（`handle(method, handler)`）；
   - Client `Builtin.listBuiltins`：`React`、`host`、`styles`（**styles 是 Builtin，不是 ctx Service**）；
   - Client `Service.listService`：`timer`（`inject: ['timer']`）；
   - Client `Slots.listSubTree`：`settings.section`（list/root，注册 `{id, order, label}`）、`tool.view.cordis`（keyed，key 只能是 `self`）。
3. `cordis_define`：`plugin.kind: "new"`，`idPrefix: "toksta"`，`code.host` = `host.js` 内容，`code.client` = `client.js` 内容；
4. `cordis_run`（mode=`run`）：Client 包首次激活需用户在 UI 批准；
5. 升级：修改源码后定义新 Package（kind=`existing`），`cordis_run` mode=`update`。

## 验收清单

- [ ] Run 卡片出现紧凑摘要（累计 Token · 连续天数 · 峰值日）
- [ ] 侧边栏「设置 → Token 用量」出现完整仪表盘
- [ ] 5 统计卡一行等宽、带边框圆角；数值单行不换行（字号自适应），各卡标签同一高度
- [ ] 热力图色阶 5 档、底部月份轴、图例「少 □□□□□ 多」
- [ ] 悬停任意方块显示「x月x日消耗了 xx Token · N 次请求」（无消耗日显示「没有 Token 消耗」）
- [ ] 无「每周/累计」tab；热力图 53 列滚动视图，**今天在最右下角**（无年分页）
- [ ] 「重新扫描」按钮可用；30s 自动刷新

## 排错速查（踩过的坑，勿重蹈）

| 症状 | 根因与修法 |
| --- | --- |
| Client 渲染崩溃 `ctx is not defined` | 组件函数里没有 `ctx`，它只在 `apply(ctx)` 作用域。组件内需定时器时用模块级桥：`apply` 里 `intervalRef = (cb, ms) => ctx.interval(cb, ms)`，组件里调 `startInterval(...)` |
| 页面只有裸文字，热力图/卡片/图例全无 | CSS 没注入：`styles` 是 Client **Builtin**（`styles.insert(css)`），`ctx.get('styles')` 返回 undefined。直接调用模块级 `styles.insert(CSS)` |
| `service "timer" is not declared` | 确认 client 有 timer Service；没有就删 `inject: ['timer']` 和 interval |
| `console.warn` 抛错 | Host builtin 只有 `console.log/error`，用 `console.error` |
| 打开设置页没有「Token 用量」 | 看 Run 卡片 / `cordis_inspect_self` 的 `client-render` 诊断 |

## 已知边界

- 只统计适配器回报了 usage 的调用（`assistant/message.usage` 缺失时跳过）；
- 当前连续天数：今天未用时算到昨天；中断未关闭的 turn 不计时长；
- 会话标题类辅助调用（`session/title-llm-request`）不计入；
- 插件定义是进程级动态 Plugin：进程重启后需按本手册重新 define（源码即本仓库）。

## 后续增强

1. 水位线缓存（`fs` Service 写工作区 JSON，启动只折增量）
2. 按模型/会话拆分（`request/header` 的 `config.model` 关联）
3. Top 会话排行榜
4. 主题色接入（`Theme.listTokens` + CSS 变量）

## 作为可安装 bundle 使用（dsh 生态标准格式）

仓库根目录即 npm 包 **`dsh-token-stats`**（`dsh.bundle` 声明），可被 `dsh plugin add` 直接安装：

```sh
dsh plugin --profile web add github:solstice621/dsh_dashboard
# 或本地路径：dsh plugin --profile web add file:/path/to/dsh-dashboard
dsh --profile web   # 重启后生效
```

- **Host 半**：`lib/index.js`（折叠逻辑 + `GET /api/token-stats` / `POST /api/token-stats/rescan` 路由供数）
- **Client 半**：`lib/client.js`（`window.__ModuleLoader__.load` 工厂，注册「设置 → 统计」分区）
- **patch**：`cordis.patch.yml` 插入 `id: token-stats` 插件行
- 注意：bundle 版与动态插件版（本会话 `cordis_define` 部署的 toksta-5）会注册同一个
  `settings.section` id `token-stats`，两者同时存在会重复；切换使用时先停掉另一方。

> 已在本机验证：`dsh plugin --profile headless add file:...` 安装成功、合成配置正确插入插件行、
> host 路由在真实日志上端到端返回正确 JSON、client 工厂形状正确（详见 progress.md 第二十节）。
