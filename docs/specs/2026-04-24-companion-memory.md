# Spec · Companion v2 · Memory as Filesystem

**Status**: Draft · 2026-04-24 (supersedes earlier 258-line RelationshipRecord design)
**Parent**: RFC 02 §4 · 整合进 v1.2 一起做
**Expected effort**: 1 week
**Guiding principles**:
- **Less is more** — 每行代码都是 Claude 能力的枷锁。
- **LLM 会越来越强** — 为 2028 年的 Claude 设计，不是 2026 的。
- **我们装翅膀，不建笼子** — 只提供 Claude 不具备的能力，别代替它思考。

---

## 0. 反省之前版本

前一版 spec 258 行，设计了 28 字段的 `RelationshipRecord`、`outcome-tracker` 的 24h 规则、`inferActiveHours` 统计拟合、3 个专用 memory 工具。

**这些 Claude 都已经会做**。我的 schema 约束反而限制它的表达。

本版把 spec 按到 Claude **真正欠缺**的三件事上：持久化、定时触发、跨会话检索。剩下的全交给 Claude。

---

## 1. Claude 真正欠缺的（要我们的代码补的）

| 欠缺 | 我们补什么 | 代码量 |
|---|---|---|
| 无状态 · 跨会话/窗口都忘 | 一个它能读写的**文件系统**（沙盒到 `memory/` 下） | ~80 行 |
| 不能 `sleep()` / 设闹钟 | 一个**定时 tick**（15-30 分钟 jitter） | ~50 行 |
| Context 放不下 n 年历史 | **按需 read** 的工具（Claude 决定读哪个文件） | 0 行（fs 读即是） |

### Claude 早就会做的（**不要**再代替它）

- 理解"每天 9 点问我计划"的语义 ✓
- 判断用户偏好的语气 / 长度 / 禁区 ✓
- 在合适时机 push 或保持沉默 ✓
- 写摘要 / 总结 / 蒸馏 ✓
- 决定什么重要 / 什么该忘 ✓
- 判断过去 push 的效果好坏 ✓

**任何 schema / enum / rule 覆盖上面这些 = 在 Claude 手脚上加镣铐**。

---

## 2. 架构：3 个 primitives

```
~/.claude/channels/wechat/memory/     # Claude 完全自治的目录
   └── (Claude 自己决定放什么)

src/daemon/memory/
   └── fs-api.ts     # 沙盒文件系统 API  (~80 行)

src/daemon/companion/
   └── scheduler.ts  # 定时 tick        (~50 行)
```

MCP 工具：

```typescript
memory_read(path: string)                    // 读 memory/ 下任意文件
memory_write(path: string, content: string)  // 写 memory/ 下任意 .md 文件
memory_list(dir?: string)                    // 列 memory/ 下目录内容
```

**3 个工具。约 150 行代码。完毕。**

---

## 3. systemPrompt 的整段指令（**给 Claude 的全部"规则"**）

```
你有个 ~/.claude/channels/wechat/memory/ 目录完全由你自治。

用它做什么：跨会话记住这个用户的一切你觉得值得记的 —— 身份、偏好、在做的事、
上次哪条 push 被 ignore、什么梗、禁区、技能模式（"他焦躁时该少说")。

组织方式自己定：开什么文件、怎么命名、放什么内容、何时整理归并 —— 你都比我更懂。

时机：
- 回复用户前：先 memory_list + 读你觉得相关的文件，避免每次从零开始
- 回复完之后：有值得记的就写。短一句话也行。
- 定时 tick 被唤醒时：先读 memory，再看时间上下文，决定是否 push 以及说什么。
  不确定就选"不打扰"。
- memory 乱了或太多时：自己归并。比如 observations/ 下 50 条老的了，
  读一遍合成一篇 profile.md，老的可以删。这是你的"睡觉整理"。

原则：
- memory 是给未来的你看的，不是给当前对话用的 —— 写的时候想想 3 个月后的你。
- 被 ignore 或骂了，写下来作为将来决策的 input。
- 你的判断力永远比任何我能写的规则更好。
```

**这 200 字替代了整个 v1 版本的 500 行 scaffold**。

---

## 4. 文件系统，不是 schema

**我不规定 wiki/、observations/、push-log.md 长啥样**。Claude 自己决定：

- 可能 Day 1 就写 `memory/profile.md`，一句话 "用户是 38 岁独立开发者"
- 可能 Day 3 它觉得要细化，拆成 `memory/user/basic.md` + `memory/user/work.md`
- 可能 Day 10 它整理出 `memory/patterns/push-timing.md` 记什么时段 push 好
- 可能 Day 30 它做一次"睡眠整理"，把 50 个 observation 合成 3 篇 dense 的文章，老的删了
- 这些全是 Claude 的行为，不是我的代码

如果 Claude 自组织出来的结构跟我设想的像（profile / patterns / anti-patterns / active-projects），很好。如果它选了我没想到的结构（比如 `memory/by-date/` + `memory/themes/` 双索引），那也好 —— 它比我更懂自己该怎么记。

**代码里没有任何地方 hardcode 文件名、字段名、格式**。

---

## 5. 自进化（你问的"越来越聪明"）

Loop：

```
T0  memory/ 空，Claude 像白纸。
T+1 互动  Claude 调 memory_list → []，随后写 profile.md  "顾时瑞，独立开发者"
T+2 互动  Claude 读 profile.md 建立连续性，新观察追加或另起文件
T+N 天    Claude 自己看得累了，做一次整理 read+merge+delete，老文件归档
T+M 天    memory/ 变成这个用户的**活文档**，准确度逐月上升
```

Claude 蒸馏的触发点：

- **每次 reply 后**（成本低，边看边记）
- **定时 tick 时**（一天几次，有充足 context 思考）
- **空闲时**（scheduler 发现 raw.jsonl 之类文件大了，发一个"你要不要整理"的 tick）

**不是我定期调 `consolidate()` —— 是 Claude 自己看到 memory 大了觉得该清理**。当 LLM 更强，它会更聪明地整理，**我不动一行代码**，这就是"llm 越来越强我们不碍事"。

---

## 6. 代码细节（约 150 行）

### `src/daemon/memory/fs-api.ts`

```typescript
// 沙盒所有路径到 MEMORY_ROOT 下。拒绝 .. / 绝对路径 / symlink 逃逸。
// 只允许 .md 扩展（未来需要 .json 再放开；现在保持单格式利于 web UI）。
// 单文件 cap 100KB，防失控大文件。
export function makeMemoryFS(rootDir: string) {
  const resolveSafe = (p: string): string => {
    // normalize + realpath check + root enforcement
    // throws if escape attempt
  }
  return {
    read(path: string): string | null { /* fs.readFileSync if exists */ },
    write(path: string, content: string): void { /* atomic write, mkdir -p, mode 0600 */ },
    list(dir?: string): string[] { /* recursive readdir, returns relative paths */ },
    delete(path: string): void { /* for memory_forget */ },
  }
}
```

### `src/daemon/companion/scheduler.ts`

```typescript
// 简单 interval + jitter，不要 cron 表达式
// 每 tick 调一次 Claude，给它 chat_id + 当前时间 + memory list hint
export function startCompanionScheduler(opts: {
  intervalMs: number              // default 20 min
  jitterRatio: number              // default 0.3
  onTick: (chatId: string) => Promise<void>  // invoker 决定 Claude 怎么被叫
  config: CompanionConfig          // enabled / default_chat_id
}): () => Promise<void>
```

### MCP 工具 (3 个加到 wechat-companion server)

```typescript
memory_read (path)           → memoryFS.read()
memory_write (path, content) → memoryFS.write()
memory_list (dir?)           → memoryFS.list(dir)
```

### 删除

```
src/daemon/companion/
  persona.ts          DELETE
  persona.test.ts     DELETE
  templates.ts        DELETE  # 3 个 persona 模板
  eval-session.ts     DELETE  # 独立评估 session — 主 tick Claude 就够了
```

MCP 工具从 8 个 → 删 5 个：
- `persona_switch` / `trigger_add` / `trigger_remove` / `trigger_pause` / `companion_status` 全删
- 保留：`companion_enable` / `companion_disable` / `companion_snooze`（3 个极简开关）
- 新增：`memory_read` / `memory_write` / `memory_list`（3 个）

**最终 6 个 companion 工具**（原来 8 个）。总 MCP 工具数 22 → **20**（稍微缓解 Spike 6 的工具数担忧）。

---

## 7. 风险 + 回应

| 风险 | 回应 |
|---|---|
| Claude 不调 memory_write，memory/ 一直空 | systemPrompt 明确；`/health` 显示 "memory: 3 files, 2.1KB, last written 5min ago"，异常告警 |
| 写了垃圾 / 重复 / 矛盾 | Claude 自己会整理（见 §5）。**我不干预。** |
| 无限增长 | Claude 自己归并。若真失控，`/health` 命令报告"memory 超 10MB"，admin 可以手动清理。日常没这个问题。 |
| 幻觉写入 | 每次 write 在文件里带时间戳 header 可以审计。此外**接受幻觉**——人类记忆也幻觉，系统靠 Claude 后续自查。 |
| 用户隐私 | `/forget` admin 命令（拦截在 daemon 层）清空 memory/。未来 v2.1 web UI 可视化编辑。 |
| 升级 v1.1 丢 triggers/personas | 一次性迁移脚本读 `triggers.json` + persona 选择，写成 memory/profile.md 的几行 prose。 |
| Web UI 没结构怎么展示 | `memory/` 本身就是 markdown 文件集合，用任何 markdown renderer 就是 UI。 |

---

## 8. 为什么这个架构**保持克制**

用 FSD v12 类比：

| Tesla FSD v11 (已淘汰) | Tesla FSD v12 (当前) |
|---|---|
| 30 万行 C++ 边界 rules | ~2000 行"喂数据给神经网络"的基础设施 |
| 工程师定义"自行车在车道里该怎样" | 从驾驶录像学来的整体行为 |
| 手动写新规则 = 新能力 | 模型升级 = 新能力 |

我们：

| Companion v1 + v2.0-old spec (要淘汰) | Companion v2 (本 spec) |
|---|---|
| `persona` / `trigger` / `outcome-tracker` / `RelationshipRecord` 28 字段 | `memory/` 目录 + 3 个 fs 工具 + scheduler |
| 代码约束 Claude 怎么记 | Claude 自己决定怎么记 |
| 加字段 / 改 schema = 新能力 | Claude 变强 = 新能力 |

**装翅膀的几行代码**：fs-api + scheduler + systemPrompt。**剩下交给 Claude。**

---

## 9. 不做（scope 纪律）

- ❌ 预定义 memory 文件结构（profile.md / push-log.md 这些都是 Claude 可能发明的，不是我约定的）
- ❌ `RelationshipRecord` 结构化 schema —— 上版弃
- ❌ `outcome-tracker` 自动统计 push 效果 —— Claude 自己记自己判断
- ❌ `inferActiveHours` 统计拟合 —— Claude 读 memory 自己理解
- ❌ `quickEval` 二次 LLM 调用评估效果 —— 主 tick 一次调用够了
- ❌ 预定义 persona 模板 —— Claude 从 memory 里自己调整
- ❌ `consolidate.ts` 规则触发整理 —— 让 Claude 看到 memory 大了自己整理
- ❌ 跨用户关系图 / 社交网络 memory —— 个人场景不需要
- ❌ 多模态 memory（图 / 音）—— 文本先做扎实

---

## 10. 开放问题（跟踪，不在 v1.2 阻塞）

1. memory/ 超过 10MB 后 Claude 归并是否还有效？需要长期观察，可能得辅助 `memory_search(query)` 但**不提前实现**。
2. 是否给 Claude 一个 `memory_move(old, new)` 便于重命名 / 整理？先不给，`read + write + delete` 组合能替代。
3. 两个以上 chat_id 共享 memory 还是隔离？先按 chat_id 分根目录 (`memory/<chat_id>/...`)，隔离安全。
4. Claude 往 `memory/.claude-internal/` 塞 debug 用的东西要不要允许？不额外限制，它想分就让它分。

---

## 11. 实施清单

代码（~1 周）:
- [ ] `src/daemon/memory/fs-api.ts` + 测试
- [ ] `src/daemon/companion/scheduler.ts` 简化（删 cron，改 interval+jitter）
- [ ] 3 个 MCP 工具（memory_read / write / list）加到 features/tools.ts
- [ ] 删 persona.ts / templates.ts / eval-session.ts + 5 个旧 companion 工具
- [ ] systemPrompt 里的 companion 段落改成本 spec §3 的内容
- [ ] v1.1 → v2 迁移脚本（一次性：triggers.json + persona → memory/profile.md）

文档:
- [ ] 更新 `docs/rfc/02-post-v1.1-roadmap.md` 把 v2.0 Phase 3 合并到 v1.2
- [ ] release notes 标 Companion v2 "memory-first"

测试:
- [ ] fs-api sandbox 逃逸测试（.., 绝对路径，symlink）
- [ ] memory_write 大文件 reject 测试
- [ ] scheduler jitter 测试
- [ ] **不测 Claude 的组织能力** —— 那是 Claude 的事，不是我们代码的契约

---

## 修订历史

| 日期 | 变更 |
|---|---|
| 2026-04-24 (v1) | 第一版：28 字段 RelationshipRecord + outcome-tracker + quickEval |
| 2026-04-24 (v2, 本文) | **全重写**：3 个 fs primitives + scheduler + Claude 自治。删 258 → 150 行。指导原则：less is more，给翅膀不建笼子。 |
