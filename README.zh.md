# dsh-token-usage-dashboard — Token 用量统计（Codex 风格）

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![deepseek-harness](https://img.shields.io/badge/topic-deepseek--harness-blue)](https://github.com/topics/deepseek-harness)

[English](README.md) | 简体中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Web UI 提供
Codex 个人主页风格的 Token 用量统计仪表盘：5 统计卡 + GitHub 风格热力图（每日/每周）+
洞察 + 模型用量排名。**界面跟随 DSH 语言设置**：中文环境显示中文仪表盘，其他语言显示英文仪表盘。

![dsh-token-usage-dashboard 仪表盘截图](assets/dsh-token-usage-dashboard.png)

## ✨ 功能

- **5 统计卡**：累计 Token 数 / 峰值 Token 数（单日）/ 最长聊天时长 / 当前连续天数 / 最长连续天数；数值字号自适应单行
- **热力图**：53 列 × 7 行滚动视图（今天恒在最右下角），悬停显示「2026年8月15日消耗了 xx Token · N 次请求」；
  「每日 / 每周」视图切换（每周为自下而上填充的 7 格柱状条，悬停显示周用量）
- **洞察**：聊天总数、LLM 请求数、会话总数、活跃天数、缓存命中率、平均每轮 Token/时长
- **最喜欢的模型**：供应商-模型（provider/model）Token 用量排名 Top5 + 比例条
- **数据源**：全部会话日志（`assistant/message` 的 `data.usage` + `request/header` 的模型归属 +
  `turn/start`/`turn/end` 时长），实时增量更新；快照持久化 + 增量同步，重启后快速恢复
- **i18n**：跟随 DSH 语言（`locale.getLocale().active`），zh → 中文 / 其他 → 英文，切换即时生效

## 🏗️ 架构说明

插件有两种运行形态，共用同一套聚合逻辑：

- **Bundle 形态**（推荐给最终用户）：通过 `dsh plugin add` 安装；npm 包内含 `lib/index.js`（Host 半）和 `lib/client.js`（Client 半）。Host 通过 webServer 注册 `GET /api/token-stats` 与 `POST /api/token-stats/rescan`；Client 注册「设置 → 统计」页面并从 API 拉取数据。
- **动态插件形态**（维护者迭代用）：将 `host.js` / `client.js` 粘贴到 `cordis_define`，可在不重启 profile 的情况下会话内部署。

数据流：

1. Host 订阅 `session/event` / `session/created`，并先对历史会话日志做一次回补。
2. 将 `assistant/message.usage`、`request/header` 模型归属、`turn/start`/`turn/end` 时长折叠为内存聚合。
3. 聚合结果周期性写入 `~/.dsh/storages/token-stats/snapshot.json`；重启时先加载快照，再只增量折叠新事件。
4. Client 轮询 `GET /api/token-stats`（扫描期 2s，就绪后 30s）并渲染仪表盘。

## 🚀 安装（bundle 方式，推荐）

```sh
dsh plugin --profile web add github:solstice621/dsh-token-usage-dashboard
dsh --profile web   # 重启后生效
```

安装后打开 **设置 → 统计** 即可看到完整仪表盘。也可本地路径安装：
`dsh plugin --profile web add file:/path/to/dsh-token-usage-dashboard`。

> 首次打开时后台扫描全部历史会话（秒级~几十秒），之后通过 `session/event` 实时增量，
> 仪表盘每 30s 自动刷新，无需手动操作。

## 🧑‍💻 动态插件部署（维护者用）

本仓库同时维护一套动态 Cordis 插件（`toksta-5`，会话内 `cordis_define` 部署，
适合在不重启 profile 的情况下迭代）：

1. `cordis_inspect_list` / `cordis_inspect_query` 核对契约（sessionQuery、session/event、
   session/created、harness、React/host/styles builtin、settings.section、timer、locale）；
2. `cordis_define`：`plugin.kind: "new"`，`idPrefix: "toksta"`，`code.host` = `host.js`，`code.client` = `client.js`；
3. `cordis_run`（mode=`run`/`update`）激活。

> ⚠️ bundle 版与动态版注册同一个设置分区 id（`token-stats`），同时启用会重复；切换前先停掉另一方。

## 📁 文件

| 文件 | 说明 |
| --- | --- |
| `lib/index.js` | **bundle Host 半**：折叠器 + 回补 + 实时监听 + `GET /api/token-stats`（`POST /api/token-stats/rescan` 备用） |
| `lib/client.js` | **bundle Client 半**：`window.__ModuleLoader__.load` 工厂，注册「设置 → 统计」 |
| `cordis.patch.yml` | bundle patch：插入 `id: token-stats` 插件行 |
| `package.json` | npm 包声明（`dsh.bundle` / `dsh.client` manifest） |
| `host.js` / `client.js` | 动态插件版 Host/Client 函数体（`cordis_define` 直接用） |
| `plugin.json` | 插件元信息与版本历史（pkg-9 … pkg-27） |
| `plan.md` / `progress.md` | 策划文档与进度档案（含全部故障/修复记录） |
| `assets/dsh-token-usage-dashboard.png` | 仪表盘截图 |

## ✅ 验收清单

- [ ] 设置 → 统计：5 统计卡一行等宽、数值单行不换行、标签同高
- [ ] 热力图 53 列、今天在最右下角、悬停显示年月日用量；「每日/每周」可切换
- [ ] 月份轴与格子逐列对齐；无横向滚动条
- [ ] 洞察 7 项数据正确；模型排名 Top5 与比例条正确
- [ ] 新对话产生后 30s 内数据自动更新
- [ ] DSH 语言切换（中↔英）时仪表盘即时切换语言

## 🩺 排错速查

| 症状 | 根因与修法 |
| --- | --- |
| `pnpm not found on PATH` | `dsh plugin` 依赖 pnpm：`corepack enable pnpm`（Node ≥16.10 自带 corepack） |
| 设置里出现两个「统计」分区 | bundle 版与动态版（toksta-5）同时启用；先停掉一方 |
| 页面只有裸文字，热力图/卡片全无 | CSS 没注入：动态版 `styles` 是 Client Builtin（`styles.insert(css)`），不能 `ctx.get('styles')`；bundle 版经 `<style>` 注入 |
| Client 渲染崩溃 `ctx is not defined` | 组件函数里没有 `ctx`，它只在 `apply(ctx)` 作用域；定时器经模块级桥（`intervalRef = (cb, ms) => ctx.interval(...)`）调用 |
| `service "timer" is not declared` | 确认 client 有 timer Service；没有就删 `inject: ['timer']` |
| 热力图下方闪现滚动条 | 旧版月份行 nowrap 标签文字撑大 scrollable overflow；容器与月份行已 `overflow:hidden` 根治 |
| `console.warn` 抛错 | Host builtin 只有 `console.log/error`，用 `console.error` |

## 📐 已知边界

- 只统计适配器回报了 usage 的调用（`assistant/message.usage` 缺失时跳过）；
- 模型归属：`assistant/message` 无 model 字段，按该会话最近一次 `request/header` 的 provider/model 归因；
- 当前连续天数：今天未用时算到昨天；中断未关闭的 turn 不计时长；
- 会话标题类辅助调用（`session/title-llm-request`）不计入。

## 🌐 生态

- ✅ [dsh-plugin-marketplace](https://github.com/YELEBAI/dsh-plugin-marketplace) 已自动收录：
  扫描验证 `verified`、一键安装（`github:solstice621/dsh-token-usage-dashboard#<commit>`）、每 2 小时自动更新锁定 commit；
- 🚀 [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) 收录 PR 已提交：
  [#225 `docs: add dsh-token-usage-dashboard`](https://github.com/0xsline/awesome-deepseek-harness/pull/225)（UI & Experience 分类，中英双语条目）。

## 📄 License

MIT
