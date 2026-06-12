# 对话页接真实数据(dialogue real data)— 设计

2026-06-11 · 状态:已与开发者确认设计决策,待实施

## 背景

`bb47712`(莫秀文)把桌面端"对话"标签替换成了静态设计稿 `dialogue-page.js`:
视觉方向(编辑部纸感、侧边栏话题分组、文档式对话流)已定,但内容全部硬编码
(假话题、假人设、密码 1234),且顶掉了原功能 pane —— sessions 列表/详情/导出、
multi-chat 导航(#56)、跨 session 搜索(b33e4fa)全部失联,`shim.e2e.test`
与 sessions 相关 Playwright specs 转红。

本设计把该页面接上真实数据,并补齐它需要的后端:规范消息存储 + 话题线索抽取。

## 设计决策(已确认)

| # | 决策 | 备选与理由 |
|---|---|---|
| D1 | **分组是滤镜(lens),不是文件夹** | 真实对话是连续流,话题多面("排产赶工"既是任务也是情绪)。硬分类必然错;线索挂多 facet,分组视图=过滤器,同一线索可出现在多个视图。与 companion persona-as-lens 哲学一致。 |
| D2 | **全量时间线兜底** | 侧边栏常驻"时间线"视图 = 该 chat 的完整对话流(与手机直觉一致)。线索只是索引;抽取慢、漏、错都不丢内容。 |
| D3 | **线索抽取搭 introspect tick 的车**(24h ± jitter) | 有 D2 兜底后新鲜度不敏感,不新增调度器。备选(对话静默触发/打开页面按需)复杂度更高,收益被 D2 抵消。 |
| D4 | **新增 `messages` 表作为规范存储 + transcripts 回填** | "不存原始消息"已不成立 —— agent session JSONL 本就明文落盘,只是散落。集中成规范表:时间线/搜索/抽取共用一个事实源;`wechat-cc.db` + `memory/` 成为可搬运单元(换机器=拷文件+扫码,接力而非实时同步 —— ilink 同一微信号同时只允许一个绑定)。 |
| D5 | **facet 少而稳:任务/知识/生活 + 独立"私密"flag + 自由 tag** | 设计稿的故事/情绪合并为"生活"(检索意图相同,LLM 不再抛硬币);股票/电视剧等闲聊兴趣天然落"生活"+tag。私密是独立轴(工作也可能敏感),锁定逻辑只看 flag。facet 是 threads 上的标签,将来拆分代价低。 |
| D6 | **线索升格门槛** | 话题**反复出现**(≥2 次独立场合)或**单次足够深**(一次 ≥~10 轮)才建线索。聊两句的内容留在时间线里、可搜索,不建线索不打 tag —— 防侧边栏噪音、防垃圾 tag。 |
| D7 | **tag 纪律** | tag 只挂线索;抽取 prompt 携带已有 tag 词表,优先复用、每线索 ≤3 个、新造仅限"明显反复出现的新概念"。词表合并清理留作后续(introspect 低频顺手做)。 |

## 数据模型(src/lib/db.ts 追加 migration,遵循 append-only)

```sql
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,          -- inbound: from_user_id:create_time_ms(复用去重键);outbound: out:<chat>:<ts>:<seq>
  chat_id     TEXT NOT NULL,
  ts          TEXT NOT NULL,             -- ISO 8601
  direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind        TEXT NOT NULL DEFAULT 'text',  -- text|image|file|voice|command(斜杠命令也落库,kind 区分)
  text        TEXT NOT NULL,             -- 媒体类存占位描述(如 "[图片] inbox/...")
  provider    TEXT,                      -- outbound 来源 provider(claude/codex/...),inbound NULL
  source      TEXT NOT NULL DEFAULT 'live'   -- live | backfill:claude | backfill:codex
) STRICT;
CREATE INDEX idx_messages_chat_ts ON messages(chat_id, ts);

CREATE TABLE threads (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  facets       TEXT NOT NULL,            -- JSON array,⊆ ["task","knowledge","life"]
  tags         TEXT NOT NULL DEFAULT '[]',
  private      INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active',  -- active|dormant|done(仅任务类有意义)
  episodes     TEXT NOT NULL DEFAULT '[]',      -- JSON [{from_ts,to_ts}](指向 messages 时间区间)
  created_ts   TEXT NOT NULL,
  last_active  TEXT NOT NULL
) STRICT;
CREATE INDEX idx_threads_chat ON threads(chat_id, last_active);
```

搜索:v1 直接 `LIKE` / 简单分词查 `messages.text`(数据量 = 个人聊天,够用);
FTS5 留作量大后的升级位,不预做。

## 写路径

- **inbound**:仿 `mw-activity` 新增 `mw-messages` middleware(`build.ts` 管线注册),
  在 access 之后记录所有放行消息(含被命令路由消费的,`kind='command'`);
  失败仅 log 不阻断管线。
- **outbound**:`send-reply.ts` 发送成功后记录(拿到 chat_id/text/provider)。
- 隐私面:与现状一致(JSONL 本就明文),`wechat-cc.db` 权限保持收紧;不新增网络暴露。

## 回填(一次性,幂等)

CLI:`wechat-cc dialogue backfill [--dry-run]`
- 来源:Claude session JSONL(`~/.claude/projects/...`,复用 `sessions read-jsonl`
  已有解析)+ Codex JSONL(`src/daemon/sessions/codex-jsonl.ts`)。
- chat 归属:经 sessions/conversations 既有映射;无法归属的 session 跳过并计数报告。
- 幂等:id 由源文件+条目位置派生,重跑 `INSERT OR IGNORE`。
- `source='backfill:*'` 标记,出问题可整批清除重跑。

## 线索抽取(introspect tick 扩展)

- 新模块 `src/daemon/threads/`(仿 `observations/` store 模式):
  `store.ts`(threads CRUD)+ `extract-prompt.ts`(prompt 构建 + 防御性解析)。
- introspect tick 在现有 observation eval 之后追加一次独立 eval(同为
  claude-haiku 单次隔离调用,失败互不影响):
  - 输入:上次抽取水位(`session_state` 存 per-chat `threads_extracted_to_ts`)
    之后的 messages 片段 + 现有 threads 摘要列表 + tag 词表(全库 tag 频次 top N)。
  - 输出:操作列表 `[{op: create|update|touch, ...}]`,按 D6/D7 规则在 prompt 中约束;
    解析失败 → 本轮放弃,水位不前进,下轮重试。
  - 私密判定:抽取时给 `private` 初值(情绪/私人生活倾向 → 1),用户可在 UI 改。
- 事件:`events` 表 kind 增加 `threads_extracted`(CHECK 约束随 migration 更新),
  记录每轮 reasoning,供日志页与调参。

## 桌面端(dialogue-page.js 重写,保留视觉语言)

- 数据通道:沿用 `wechat_cli_json` invoke → 新 CLI 子命令
  `wechat-cc dialogue timeline|threads|search|thread-detail … --json`(读 SQLite)。
- 侧边栏:顶部 chat 切换(吸收 #56 multi-chat 导航)→ 固定项"时间线" →
  三个 facet 视图(任务/知识/生活)→ 私密区(锁,见下)。
  facet 视图内 = 线索卡(title/tags/status/last_active —— 设计稿样式,
  "进度 60%"替换为 status 文案)。
- 主区:
  - 时间线视图:文档式对话流(设计稿排版,真实头像/昵称),按时间分页懒加载(每页 ~100 条,向上翻历史)。
  - 线索详情:summary + episodes 区间的消息渲染 + "在时间线中查看"跳转。
  - 搜索框(顶部,沿用防抖逻辑):查 messages,命中跳时间线定位。
- 私密锁:锁 `private=1` 的线索(任何视图统一隐藏,解锁后显示)。
  密码:`agent-config.json` 存 scrypt 哈希,桌面设置页设置/修改;未设置密码 → 不启用锁。
  demo 的 `PRIVATE_PASSWORD="1234"` 删除。
- 导出 markdown 保留(时间线维度);删除/JSONL 下载从本页移除(CLI 仍可用)。
- 旧 `modules/sessions.js` 中被取代的接线移除,避免死代码。

## 测试

- 单测:messages store / mw-messages / 回填幂等 / extract-prompt 解析(含畸形输出)/ threads store。
- daemon e2e:fake-sdk 对话 → messages 落库断言;introspect tick(fake eval)→ threads 产生。
- shim e2e:锚点列表按新 DOM 重写(`dialogue-*` id 取代 `sessions-*` 系)。
- Playwright:sessions-pane / sessions-multichat / interactions specs 对齐新页面;新增 timeline 分页与私密锁 spec。
- 抽取质量:复用 `eval/` 机制做 thread-extraction eval 集 —— **独立后续项**,不阻塞本工程合并。

## 不做什么(YAGNI)

- 进度百分比(LLM 编数)→ status 三态。
- 故事/情绪独立 facet → 并入"生活",数据驱动地观察是否需要拆。
- 跨机实时同步(ilink 单绑定约束)→ 仅保证数据单元可搬运;export/import 命令留作后续。
- FTS5 / 向量检索;tag 词表自动合并;companion 引用线索 —— 全部后续。

## 风险

- 回填的 chat 归属映射不全 → dry-run 先报告比例,接受部分历史缺失(时间线从今往后完整)。
- 抽取质量(升格门槛/私密误判)需调参 → events reasoning + 后续 eval 集兜住;错了可整表重抽(messages 是事实源)。
- `bb47712` 同期的 memory/dialogue 视觉改动与本工程并行演进 → 实施前 rebase 到 dev 最新。
