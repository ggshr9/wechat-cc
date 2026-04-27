# `wechat-cc update` 设计

**Status**: draft, brainstormed 2026-04-27
**Owner**: ggshr9
**Tracks**: RFC 02 §5 v2.1 · UX & 分发 ·「桌面端一键升级」

## 1. 目的

桌面 Tauri GUI 的「Update」按钮要靠一条幂等、JSON 输出、可在不副作用模式下被定时探测的 CLI 命令。当前 README §Updating 已把 `wechat-cc update` 写成承诺，但 `cli.ts` 里没有 `update` case —— 本 spec 落地这条命令并补全测试。

非目标：

- 不做完整热升级（失败回滚 + 续会话），先做基础闭环
- 不管 provider 二进制（`claude` / `codex` CLI）的版本，那由 `wechat-cc doctor` 报
- 不动桌面 GUI bundle 的升级（Tauri updater 是另一条路径）

## 2. 命令行

```
wechat-cc update --check [--json]    # 探测，无副作用
wechat-cc update [--json]              # 真升级
```

非 JSON 模式输出单行人话 + exit code（成功 0，拒绝/失败 非 0）。`--json` 时永远 exit 0，由 `ok` 字段表态。

## 3. JSON 形状

### `--check` 输出

```json
{
  "ok": true,
  "mode": "check",
  "currentCommit": "d298584",
  "latestCommit": "a1b2c3d",
  "updateAvailable": true,
  "behind": 3,
  "aheadOfRemote": 0,
  "lockfileWillChange": true,
  "dirty": false,
  "dirtyFiles": []
}
```

`fetch_failed` / `detached_head` 这类错误时 `ok:false` + `reason` + `message`，
形状与 apply 拒绝结果一致。

### apply 成功

```json
{
  "ok": true,
  "mode": "apply",
  "fromCommit": "d298584",
  "toCommit": "a1b2c3d",
  "lockfileChanged": true,
  "installRan": true,
  "daemonAction": "restarted",
  "elapsedMs": 8421
}
```

`daemonAction` 取值：

- `restarted` —— 升级真做了 + service 已重启
- `noop` —— daemon 升级前就没跑，或者根本没有要升级（早返回路径）
- `restart_failed` —— 升级本身成功但 `service start` 报错；调用方应当再点一次 `service start`

### apply 拒绝 / 失败

```json
{
  "ok": false,
  "mode": "apply",
  "reason": "<封闭枚举>",
  "message": "<人话>",
  "details": { ... }
}
```

`reason` 封闭枚举：

| reason | 触发 | `details` 字段 |
|---|---|---|
| `dirty_tree` | `git status --porcelain` 非空 | `dirtyFiles: string[]` |
| `diverged` | local 有 origin 没有的 commit（`aheadOfRemote > 0`） | `aheadBy`, `behindBy` |
| `detached_head` | `git symbolic-ref HEAD` 失败 | `currentCommit` |
| `fetch_failed` | `git fetch origin` 非零退出 | `stderr` |
| `pull_conflict` | `git pull --ff-only` 非零退出 | `stderr` |
| `install_failed` | `bun install --frozen-lockfile` 非零退出 | `stderr` |
| `bun_missing` | 需要装依赖时 `findOnPath('bun')` 为 null | — |
| `daemon_running_not_service` | daemon alive 但不是 service 安装 | `pid` |
| `service_stop_failed` | `service.stop()` 抛错 | `stderr` |

## 4. 架构

新建 `update.ts`（仓库根，与 `doctor.ts` / `account-remove.ts` / `daemon-kill.ts` 同级），导出：

```ts
export interface UpdateDeps {
  repoRoot: string
  stateDir: string
  runGit(args: string[]): { stdout: string; stderr: string; code: number }
  bun: { path: string | null; install(): { stderr: string; code: number } }
  daemon: () => { alive: boolean; pid: number | null }
  service: {
    installed: () => boolean
    stop: () => void
    start: () => void
  }
  now?: () => number
}

export interface UpdateProbe {
  ok: boolean
  mode: 'check'
  currentCommit?: string
  latestCommit?: string
  updateAvailable?: boolean
  behind?: number
  aheadOfRemote?: number
  lockfileWillChange?: boolean
  dirty?: boolean
  dirtyFiles?: string[]
  reason?: string
  message?: string
  details?: Record<string, unknown>
}

export interface UpdateResult { /* mirror JSON shapes above */ }

export function analyzeUpdate(deps: UpdateDeps): UpdateProbe
export async function applyUpdate(deps: UpdateDeps): Promise<UpdateResult>
export function defaultUpdateDeps(repoRoot: string, stateDir: string): UpdateDeps
```

`cli.ts` 加 `update` 与 `update --check` 两个 case，注入
`defaultUpdateDeps(here, STATE_DIR)`，重用 `service-manager.ts` 的
`startService` / `stopService` 与 `agent-config` 加载。

## 5. 数据流

### `analyzeUpdate(deps)` —— 无副作用

1. `git fetch origin`  → `fetch_failed`
2. `git symbolic-ref --short HEAD`  → `detached_head` 时 reject
3. `git rev-parse HEAD`  → `currentCommit`
4. `git rev-parse origin/<branch>`  → `latestCommit`
5. `git rev-list --count <currentCommit>..<latestCommit>`  → `behind`
6. `git rev-list --count <latestCommit>..<currentCommit>`  → `aheadOfRemote`
7. `git status --porcelain`  → `dirty` + `dirtyFiles`
8. `git diff --name-only HEAD origin/<branch> -- bun.lock`  → `lockfileWillChange`
9. `updateAvailable = behind > 0`

### `applyUpdate(deps)` —— 真升级

1. `probe = analyzeUpdate(deps)`
2. `probe.ok === false` → 透传 reject
3. `probe.dirty` → reject `dirty_tree`
4. `probe.aheadOfRemote > 0` → reject `diverged`
5. `!probe.updateAvailable` → 早返回 `ok:true, daemonAction:"noop", lockfileChanged:false`
6. 探 daemon 状态：
   - `daemon.alive && service.installed` → 记 `wasService=true`，`service.stop()`，失败 → reject `service_stop_failed`
   - `daemon.alive && !service.installed` → reject `daemon_running_not_service`
   - `!daemon.alive` → `wasService=false`
7. `git pull --ff-only`  → `pull_conflict`（不自动重启 service —— 已知 stale）
8. `probe.lockfileWillChange` 为真：
   - `bun.path === null` → reject `bun_missing`
   - 否则 `bun install --frozen-lockfile`  → `install_failed`（同样不重启 service）
9. `wasService` 为真 → `service.start()`，失败时返回 `ok:true, daemonAction:"restart_failed"`
10. 收尾返回 `ok:true, elapsedMs`，`daemonAction` 取：
   - `restarted` 当 `wasService=true` 且 `service.start()` 成功
   - `restart_failed` 当 `wasService=true` 且 `service.start()` 抛错
   - `noop` 当 `wasService=false`（daemon 升级前就没跑）

错误优先级：`dirty_tree > diverged > daemon_running_not_service > service_stop_failed > pull_conflict > bun_missing > install_failed`。

### 关键约束

- 分支取当前 `HEAD` 的 symbolic-ref（不硬编码 `master`），fork 也能用
- `--ff-only` 拒绝 merge / rebase；任何分叉一律走 `diverged`
- 第一版**不做回滚**。失败让用户用 `git reflog` 自救
- service 重启失败不阻塞成功汇报；GUI 据 `daemonAction:"restart_failed"` 引导用户重试

## 6. 测试

### 6.1 `update.test.ts`（vitest, 假 deps，18 case）

`analyzeUpdate`：
1. clean tree + behind=3 + lockfile diff → `updateAvailable=true, lockfileWillChange=true`
2. clean tree + behind=0 → `updateAvailable=false`
3. dirty tree → `dirty=true, dirtyFiles=[…]`
4. ahead=2, behind=0 → `aheadOfRemote=2, updateAvailable=false`
5. fetch 失败 → `ok:false, reason:"fetch_failed"`
6. detached HEAD → `ok:false, reason:"detached_head"`
7. git binary 缺失（runGit 抛 ENOENT）→ `ok:false, reason:"fetch_failed"`

`applyUpdate`：
8. dirty → reject `dirty_tree`，所有 mutating spy 调用零次
9. diverged → reject `diverged`
10. daemon alive 非 service → reject `daemon_running_not_service`，pull 没跑
11. service.stop 抛错 → reject `service_stop_failed`，pull 没跑
12. pull 失败 → reject `pull_conflict`，install 没跑，service 已 stop 但未 start
13. install 失败 → reject `install_failed`，service 仍 stop
14. bun 缺失（lockfile 变）→ reject `bun_missing`
15. lockfile 不变 → 跳过 install，`installRan=false`
16. service.start 失败 → `ok:true, daemonAction:"restart_failed"`
17. happy path（service 在跑）→ stop / pull / install / start，`daemonAction="restarted"`
18. happy path（daemon 没跑）→ 跳过 stop/start，`daemonAction="noop"`

### 6.2 `update.e2e.test.ts`（vitest, 真 git，假 service，6 case）

`mkdtemp` 起两个临时 repo（"upstream" + "local"），`git clone` 关系；service deps 用 spy。

1. **happy path** —— upstream 加 commit + 改 bun.lock → `applyUpdate` → assert `HEAD` 推进、bun.lock 内容到位、`service.stop+start` 各调一次
2. **dirty tree** —— local 写未 commit 文件 → reject `dirty_tree`，HEAD 不变
3. **diverged** —— local commit + upstream 不同 commit → reject `diverged`
4. **no-op** —— upstream 无新 commit → `updateAvailable=false`，service 没动
5. **lockfile 不变** —— upstream 加非 lockfile commit → `installRan=false`
6. **`--check` 不副作用** —— upstream 加 commit → `analyzeUpdate` → assert local HEAD 不变、working tree 干净

`pull_conflict` 不进 e2e —— `aheadOfRemote > 0` 的 `diverged` 前置检查在真实场景里几乎覆盖所有非 ff 情况，剩下的需要 hook 失败 / 仓库损坏才能触发，e2e 复现脆弱、回报低。Task 6 的单元测试用假 `pull: fail(...)` 已经证明 applyUpdate 在 `git pull` 非零退出时的行为。

### 6.3 `cli.test.ts` 增量

- `update` / `update --json` / `update --check` / `update --check --json` 的 args 解析
- 对应 case 调对应函数（spy）
- git 不存在时 exit code 非零（仅非 JSON 模式）

### 6.4 CI

`.github/workflows/desktop.yml` 的 vitest 显式 list 追加 `update.test.ts` 和
`update.e2e.test.ts`。

## 7. 不做的事

- 升级失败的自动回滚（C 档完整热升级，第二版再说）
- 桌面 GUI bundle 的自更新（Tauri updater 路径）
- provider 二进制版本管理（doctor 已经报）
- 升级前的 `bun test` / `bun typecheck` 自检（信任 origin/master 的 CI 已过）
- migration 钩子（当前没有 schema 变更需要迁移）

## 8. 风险

| 风险 | 概率 | 兜底 |
|---|---|---|
| pull 后 install 失败让 daemon 起不来 | 中 | reject 后用户跑 `wechat-cc service start` 走旧的 node_modules（lockfile 已是新的 → install 重试） |
| service.stop 之后 pull 失败，daemon 永久停 | 低 | 设计就这样：用户看到 `pull_conflict` 自己 fix + `service start`；GUI 据此提示 |
| 用户在 fork 上跑，`origin/<branch>` 不存在 | 低 | `git rev-parse` 会失败 → `fetch_failed`；message 可提示设置 upstream remote |
| `--ff-only` 在 rebase workflow 下永远 diverged | 低 | 这就是设计意图，提示用户手动升级 |

## 9. 验收

- [ ] `wechat-cc update --check --json` 返回上面定义的 schema
- [ ] `wechat-cc update --json` 在 happy path 真把 daemon 重启
- [ ] dirty / diverged / detached_head / 裸跑 daemon 全部 reject 不破坏状态
- [ ] `update.test.ts` + `update.e2e.test.ts` 全部通过
- [ ] CI workflow 跑这两个 test 文件
- [ ] README §Updating 段落保持不变（命令兑现承诺）
