# RFC 02 · wechat-cc Post-v1.1 Roadmap (v1.1-final → v2.1)

**Status**: v1.2 shipped 2026-04-24 · v2.1 not started
**Supersedes**: none (extends RFC 01 §7 Roadmap)
**Context**: v1.1.0-rc.1 tagged 2026-04-22; 6 reliability fixes landed in 2cab581 (2026-04-23); cc-connect audited 2026-04-24; v1.2 closed 2026-04-24 (3.5-day sprint vs 3-4 wk budget — less-is-more paid off)

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

## 3. v1.2 · 可靠性收口 ✅ shipped 2026-04-24

实际 3.5 天完成（原预算 2-3 周）。见 `docs/releases/2026-04-24-v1.2.md`。

**核心任务完成情况**：

1. ~~**MCP 工具拆包**（Spike 6 兑现）~~ → **SKIP**（2026-04-24 决策）
   - 原顾虑：ToolSearch round-trip 加 10-15s 延迟
   - 实际：`preset+append` 已把 MCP tools inline 到 system prompt，延迟消除
   - 拆 MCP server 会改 tool 名（`mcp__wechat__reply` → `mcp__wechat_core__reply`），破坏 Claude 已建立的工具使用模式
   - `ilink-glue.ts` 拆包已给了模块边界，未来真需要 MCP 拆时不会被 monolith 挡住
2. ✅ **errcode=-14 可见化**（commit 209b846）— `SessionStateStore` + `/health` + `清理 <bot-id>` 命令。用户 2026-04-21 明确选 pull-based（admin 查 /health 才告警），不主动推。
3. ✅ **会话持久化**（commit ec675c2）— SDK `resume: <session_id>` + `sessions.json` 持久化 map + jsonl 存在性校验 + 7 天 TTL。
4. ~~**死 bot 自动降级**~~ → 合并到 Task 2，按用户 pull-based 决策执行。
5. ✅ **Codex hook 修**（操作性，非代码）— `/codex:setup` 切到 `gpt-5-codex`。
6. ✅ **`ilink-glue.ts` 拆包**（commit c5f8587，原 §8.4 开放问题）— 558 → 263 行 + `ilink/{context,voice,companion,transport}.ts`。
7. ✅ **语音 voice_item 回落到文件附件**（commit a847716）— Spike 4 已确认微信客户端静默丢弃 voice_item；修正 2cab581 里 commit message 与代码自相矛盾的地方。
8. ✅ **`[SESSION_EXPIRED]` / `[TYPING]` 路由到 channel.log**（commit ec79492）— 之前只走 stderr，log-viewer 看不见。

**验收**：
- ✅ 重启 daemon 后 resume 命中（sessions.json 有 compass 条目，手测过）
- ✅ 死 bot 可通过 `/health` 查看 + `清理所有过期` 清理
- ✅ ~~22 tools 分布到 3-5 个 MCP server~~ → 上游改为：`ilink-glue.ts` 拆包 + 保留单 MCP server（tool 名不破坏）

---

## 4. Companion v2 ✅ shipped with v1.2

Commits: 38900ff (memory fs-api) + 13bf29f (prune rules) + 467937f (bootstrap follow-through).

**删的代码**：`src/daemon/companion/{persona,templates,eval-session}.ts` + 5 工具（persona_switch / trigger_add / trigger_remove / trigger_pause / 原 companion_status 的 scaffold 含义）。

**加的代码**：
- `src/daemon/memory/fs-api.ts` ~80 行（沙盒 FS：.md only / 100KB / 路径校验 / atomic rename）
- 3 工具：`memory_read` / `memory_write` / `memory_list`
- scheduler 简化到 59 行（从 104 行），setInterval + jitter 替代 croner cron

**Companion 工具总数：8 → 6**（4 开关 + 3 memory — 实际 wire 起来是 enable/disable/status/snooze 4 + memory_read/write/list 3 = 7；companion_status 保留，simplified）。MCP 总工具数 22 → 21。

**E2E 验证（2026-04-24 手测）**：用户教 bot "我叫丸子" → `memory/<chat_id>/profile.md` 被 Claude 自主写入；清掉 session jsonl 重启 daemon 再问 → Claude 读 memory 回答 "丸子 🍡"。自学习链路跑通，无硬编码规则。

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

1. ~~v2.0 relationship.json 存储策略~~ → N/A（v2 memory-first 用 Claude 自治文件组织，单 writer + atomic rename 已够）
2. Web dashboard 技术栈：继续 `marked` + loopback HTTP 简单站点，还是引入 SvelteKit / React？（倾向前者，小白友好 + 无 bundle step）
3. v2.1 onboarding 里 systemd user service 自动化能不能跨 Linux 发行版？（systemd 普适，cron fallback 对应古早系统）
4. ~~`ilink-glue.ts` 拆包~~ → ✅ commit c5f8587（2026-04-24），独立于 MCP 拆包完成

---

## 修订历史

| 日期 | 变更 |
|---|---|
| 2026-04-24 晨 | 初稿，继承 RFC 01 方向并在 cc-connect 审计后固化定位 |
| 2026-04-24 晚 | v1.2 shipped。Task 3 MCP 拆包降级为 skip（preset+append 已覆盖）。Task 5 (ilink-glue split) 独立完成。voice_item→file-attachment + log-routing 两个 silent-failure 修复。 |
