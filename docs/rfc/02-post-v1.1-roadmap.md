# RFC 02 · wechat-cc Post-v1.1 Roadmap (v1.1-final → v2.1)

**Status**: Draft · 2026-04-24
**Supersedes**: none (extends RFC 01 §7 Roadmap)
**Context**: v1.1.0-rc.1 tagged 2026-04-22; 6 reliability fixes landed in 2cab581 (2026-04-23); cc-connect audited 2026-04-24

---

## TL;DR

cc-connect 已经占了**通用 bridge × 多平台 × 多 agent**的广度生态位（v1.3，11 IM + 10 agent）。wechat-cc 不去追那片红海，沿 RFC 01 定位**"个人 Claude Code 伴侣 × 深度 × 小白"**继续打纵深。

四阶段节奏（2026-04-24 调整）：

| 版本 | 主题 | 工期 | 核心产出 |
|---|---|---|---|
| v1.1.0 final | 清尾 | 1 周 | Companion scaffold 标 experimental（准备被 v1.2 替换）+ voice 退役 notes + tag |
| **v1.2** | 可靠性 + Companion v2 | 3-4 周 | 会话 resume + errcode 可见 + MCP 拆包 + **Companion memory-first 重写**（memory/ fs 自治, 删 persona/trigger CRUD） |
| **v2.1** | UX & 分发 | 2-3 周 | Web dashboard（呈现 memory/*.md）+ onboarding + plugin marketplace 上架 |

总计 **6-8 周**。比原计划少 2-3 周 —— 因为**删掉了原 v2.0 Phase 3 的 258 行 RelationshipRecord 设计**，按 Karpathy LLM wiki 哲学简化：只给 Claude 文件系统 + 定时器，其余自治。见 `docs/specs/2026-04-24-companion-memory.md` v2 版。

**设计信条**: less is more；LLM 只会越来越强；我们装翅膀不建笼子。

---

## 1. 定位再确认（cc-connect 对照后）

今晚对 [`chenhg5/cc-connect`](https://github.com/chenhg5/cc-connect) v1.3 做了完整功能审计。结论：

**cc-connect 是广度王**：
- 11 IM（Feishu / DingTalk / Slack / Discord / Telegram / LINE / WeChat Work / 个人 WeChat / Weibo / QQ / QQ 官方）
- 10+ agent（Claude Code / Codex / Cursor / Gemini / Qoder / OpenCode / iFlow / Kimi / Pi + ACP 通用）
- 已有 web admin UI（5 语言）+ lifecycle hooks + 运行时切 provider

**wechat-cc 不追也追不赢**。但 cc-connect **没有**的东西：
- ❌ Proactive Companion（Claude 自判断是否/何时/说什么 push）
- ❌ Relationship memory（per-chat 偏好 / 关系历史 / 效果学习）
- ❌ share_page 带 Approve button（cloudflared tunnel + 微信浏览器阅读 + 一键确认）
- ❌ Agent SDK 原生 `canUseTool` 权限流（cc-connect 是通用 admin_from 审批）
- ❌ 跨项目 handoff（`_handoff.md` 写到 target memory/ ）

**结论**：wechat-cc 的差异化是 **L4 Companion 层**（RFC 01 §3.L4）。后续每个版本的工作都应该问一个问题："这件事让我们更不像 cc-connect 吗？" 是，就做；像，就舍。

---

## 2. v1.1.0 final · 清尾 (1 周)

**目的**：v1.1.0-rc.1 → v1.1.0 正式 tag。不加新功能，只关流。

| 事 | 成本 | 责任 |
|---|---|---|
| Task 22 Companion E2E 微信手测走全流程（enable → trigger → 看 push → persona 切 → snooze → disable） | 30 分钟 | 顾时瑞（user） |
| 死 bot 清理：`8ca10d158998-im-bot` + `b1188b8b0251-im-bot` 两个 session timeout 挂 > 48 小时，从 `accounts/` 目录删 | 5 分钟 | 我 |
| `docs/releases/2026-04-22-v1.1.md` 加"Known issue: 语音退役"段（引用 memory/project_wechat_cc_voice_bubble.md） | 10 分钟 | 我 |
| git tag `v1.1.0` + push | 2 分钟 | 我 |

**Not in scope**：Spike 4/5/6 继续 defer（Spike 4 已 closed，5/6 进 v1.2）。

---

## 3. v1.2 · 可靠性收口 (2-3 周)

见 `docs/specs/2026-04-24-v1.2-reliability.md` 详情。

**核心任务**（按 value/cost 排序）：

1. **MCP 工具拆包**（Spike 6 兑现）。22 tools 在一个 MCP 里让 SDK 纠结 ToolSearch → 今晚已用 preset+append 绕开，但治标不治本。按功能拆三个：
   - `wechat-core`（6 tools）：reply / edit_message / send_file / set_user_name / broadcast / send_file
   - `wechat-project`（4 tools）：list/switch/add/remove project
   - `wechat-companion`（8 tools）：enable/disable/status/snooze + persona_switch + trigger_add/remove/pause
   - 可选 `wechat-docs`（2 tools）：share_page / resurface_page
   - `wechat-voice`（3 tools）**仍隐藏**直到 Tencent 修 openclaw/#56225
2. **errcode=-14 可见化**。poll-loop 的 `[ERROR]` 只走 transport 异常；`JSON.parse` 拿到 errcode != 0 属于"正常响应"被默默咽掉。session timeout 是 -14，语义上必须升级为警报（推 admin）+ 标记该 bot inactive。
3. **会话持久化**。当前 SessionManager 在内存；daemon 重启 → pool 空 → 下次消息必冷启动（~10s）。接 SDK 的 `resume: <session_id>`（见 2.daemon/bootstrap.ts + src/core/session-manager.ts），在 pool 里加持久化 map：`alias → last session_id`（写 `~/.claude/channels/wechat/sessions.json`），spawn 时优先 resume。
4. **死 bot 自动降级**。当某 bot 连续 N 次 getupdates errcode=-14，mark dormant + 一次性通知 admin "xxx bot 的 session 过期了，用 `wechat-cc setup` 重扫"；poll-loop 暂停该 loop。
5. **Codex hook 修**。今晚我们手动 `stopReviewGate=false` 关掉；根因是 codex 配置指向 `gpt-5.5`（不存在模型），应该 `/codex:setup` 改到 `gpt-5` 或 `gpt-5-codex`。非 wechat-cc 代码本身，顺手记录。

**验收标准**：
- 重启 daemon 后，user 发第一条消息 <3s 首 token（resume 命中）
- 死 bot 至少触发一次 admin 推送告警（不再 silent drop）
- 22 tools 分布到 3-5 个 MCP server，`ListTools` 返回能看出分组

---

## 4. Companion v2 合并进 v1.2 一起做

原 v2.0 Phase 3 已**合并到 v1.2**。核心设计改版见 `docs/specs/2026-04-24-companion-memory.md`（v2 版，150 行）。

**思路转向**：
- 之前（v1 spec）：28 字段 RelationshipRecord + outcome-tracker + active-hours 统计拟合 + 3 个专用 memory 工具
- 现在（v2 spec）：`memory/` 目录沙盒 + 3 个 fs 工具 (read/write/list) + scheduler 定时 tick + 一段 systemPrompt。Claude 自治文件组织、自治整理、自治判断。

**删的代码**：
- `src/daemon/companion/persona.ts` + `templates.ts` + `eval-session.ts`
- 5 个工具：`persona_switch` / `trigger_add` / `trigger_remove` / `trigger_pause` / `companion_status`

**加的代码**：
- `src/daemon/memory/fs-api.ts` ~80 行（沙盒 FS）
- 3 个工具：`memory_read` / `memory_write` / `memory_list`
- scheduler 简化

**Companion 工具总数：8 → 6**（3 个开关 + 3 个 memory）；MCP 总工具数 22 → 20。

---

## 5. v2.1 · UX & 分发 (2-3 周)

**三件事**：

1. **Web dashboard**（`src/web/` 新增 — upgrade from `log-viewer.ts`）：
   - 左侧：当前 sessions（project × chat_id 二维矩阵 + lastUsedAt）
   - 中间：最近消息流（SSE stream from channel.log）
   - 右侧：Companion 决策可视化（"3 分钟前 Claude 决定不 push，理由：user 在 focus 中"）
   - Tab：**`memory/*.md` 文件浏览器 + markdown 渲染**（用户的数字画像，可 inline 编辑）。因为 v1.2 把 memory 设计成 markdown 文件集合，web UI 天然只是 markdown renderer
2. **Onboarding 流**（`wechat-cc setup` 升级）：
   - 扫码后不只写 account files，起一个简短 demo：自动给新用户发一条"你好，我是 Claude"类 greeting
   - 一步到位提示 `wechat-cc install --user` + 启 daemon 的 systemd user service（当前需要用户手动）
   - 错误恢复（QR 过期 / 网络问题）natural language 提示
3. **Plugin marketplace 上架**：
   - `.claude-plugin/plugin.json` 补齐 metadata
   - README.md 面向非开发者重写（当前还是偏技术）
   - 提交到 Anthropic 的 claude-plugins marketplace（如果 program 开放）

---

## 6. 绝对不做的事（scope 纪律）

继承 RFC 01 §6，加三条今晚学到的：

- ❌ **追平 cc-connect 的 11 平台** — 红海，必输，定位失焦
- ❌ **支持企业微信 / Slack / Feishu** — 偏离"个人"
- ❌ **多 agent 适配（Codex/Cursor/Gemini）** — 偏离"Claude Code 深度"
- ❌ **自建 TTS 服务** — voxcpm-server 项目今晚已退役；架构口子留在 wechat-cc 内（src/daemon/tts/http_tts 通用 OpenAI 兼容接口），Tencent 修 sendVoice 后直接接回
- ❌ **手写 SILK 编码器 / 抓包逆向 WeChat 协议** — 超出 scope，等 Tencent
- ❌ **把 Companion 做成 general rule engine** — Companion 的差异化是"Claude 自判断"，硬编码规则等于退化成 cc-connect 的 /cron

---

## 7. 风险 & 兜底

| 风险 | 概率 | 兜底 |
|---|---|---|
| Task 22 E2E 暴露 Companion scaffold 的 bug | 中 | 先修再 tag v1.1.0；真有大坑推 v1.1.1 |
| v1.2 MCP 拆包破坏 Claude 已建立的工具使用模式 | 低 | 先灰度（feature flag），观察 1 周再默认开 |
| v2.0 relationship memory 被 Claude 乱写（比如错误标 "stressed"）| 中 | 用户可在 web UI 手动修正 + 重建 memory；关 Companion 后 memory 冻结 |
| v2.1 marketplace 上架条件变（Anthropic policy）| 中 | 保留自行分发路径（GitHub + `wechat-cc install --user`） |
| Tencent 突然开放 sendVoice（反而好事但要改）| 低 | voice 架构口子留着，一周内能重启 |

---

## 8. 开放问题（跟踪列表）

1. v2.0 relationship.json 存储策略：单文件还是 per-chat 分文件？并发写入如何保序？
2. Web dashboard 技术栈：继续 `marked` + loopback HTTP 简单站点，还是引入 SvelteKit / React？（倾向前者，小白友好 + 无 bundle step）
3. v2.1 onboarding 里 systemd user service 自动化能不能跨 Linux 发行版？（systemd 普适，cron fallback 对应古早系统）
4. `ilink-glue.ts` 648 行已过膨胀阈值，要不要配合 v1.2 MCP 拆包顺手拆成 `ilink-core / ilink-voice / ilink-companion` 三个 adapter？

---

## 修订历史

| 日期 | 变更 |
|---|---|
| 2026-04-24 | 初稿，继承 RFC 01 方向并在 cc-connect 审计后固化定位 |
