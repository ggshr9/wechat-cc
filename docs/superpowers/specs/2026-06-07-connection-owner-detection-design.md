# 连接归属检测 — 让用户知道"本机到底连没连上 WeChat"

**Date:** 2026-06-07
**Status:** Design (awaiting review)

## 问题

WeChat 只允许绑定**一个 bot**,且该 bot 的 ilink 长轮询连接在**同一时刻只能被一台机器**持有。用户可能在多台机器上装了 wechat-cc,但不知道**哪一台才是当前真正在收发消息的那台**。

当前 dashboard 的"已连接"判定是**纯本地状态的假阳性**:hero「AI 正在陪伴中 / 一切正常,连接稳定」的条件就是

```js
// apps/desktop/src/view.js:330-353  dashboardHero()
if (daemon.alive || accountCount > 0) { /* tone: "ok" → 显示已连接 */ }
```

即"本机 daemon 进程活着 **或** 本地存了已绑定账号"就显示绿。它**完全没有**检查这台是不是真的握着 ilink 连接、是不是真的在收消息。

### 实测证据(2026-06-07)

真实连接此刻在另一台(公司)电脑上。在本机直接用本地 token 打一次 `ilinkGetUpdates(baseUrl, token, '')`:

```
RESP after 1612ms:  ret=undefined  errcode=-14  errmsg="session timeout"  msgs=0
```

同时本机 `session_state` 表为空(没记录 expired),dashboard 仍显示"已连接/连接稳定"。**假绿实锤**。同时确认:`-14` 信号**真实、且快(~1.6s 返回,非 35s 长轮询挂起)**,适合做按需探测。

## ilink 给的唯一真实信号

`getUpdates` 在本机会话已被别处 rebind / 失效时返回 **`errcode=-14`**(errmsg `"session timeout"`)。代码里现有处理:

- `src/daemon/ilink/transport.ts:72-83` — `getUpdatesForLoop` 收到 `-14` → `sessionState.markExpired(accountId)` → 返回 `{ expired: true }`。
- `src/daemon/poll-loop.ts:272-283` — `if (resp.expired) { … break }` — **直接停掉轮询循环,不自动重试、不自愈**。

**关键性质:被接管是终态。** 一个 bot,被别的设备 rebind 走,本机 token 即失效;要在本机重新接管**只能让用户重新扫码绑定**。所以"未连接(被接管)"不该显示成"正在恢复中"。

ilink **不提供**:枚举设备 / 设备身份 / "谁在连"目录 / 心跳时间戳。因此无法直接列出"哪台在连",**只能让每台机器自检"我是不是那台"**。

## 设计

### 1. 三态连接模型(替换本地二元判断)

| state | 判定来源 | hero headline | hero meta | 主操作 |
|---|---|---|---|---|
| `connected` | 最近一次 getUpdates 成功(`lastUpdateOkAt` 在新鲜窗口内)且未 expired | **AI 正在陪伴中** | 连接正常 · 上次活动 {X} 前 | 断开连接 |
| `recovering`(临时) | daemon 没起 / 网络错误 / 尚无成功 poll,但**未**收到 `-14` | **暂时失联** | 正在恢复连接… | 重启 daemon |
| `taken_over`(终态) | 收到过 `-14`(被动 by loop **或** 主动 by probe) | **本机未连接** | 连接在其他设备 · 重新扫码可接管 | **重新扫码绑定** |

文案按用户反馈收敛到最短:`taken_over` 用 headline「本机未连接」+ meta「连接在其他设备 · 重新扫码可接管」,不出现"被接管/终态"等术语。

### 2. 方案1(主力):主动"测试本机连接"

- **后端**:新增内部 API 路由 `POST /v1/connection/probe`(`src/daemon/internal-api/routes.ts`)→ 调 `ilinkGetUpdates(baseUrl, token, '')`,**客户端侧 ~5s abort**:
  - 收到 `errcode/-14` within 5s → `taken_over`;同时走现有 `markExpired` 路径,与被动检测一致。
  - 5s 内无 `-14`(服务端在长轮询挂着 = 接受了本机会话) → `connected`。
  - 网络/其他错误 → 结论 `inconclusive`,UI 提示"网络异常,稍后重试",**不**翻成 `taken_over`。
- **CLI**:新增 `wechat-cc connection probe`(headless 用),并把结果并入 `wechat-cc doctor` 的输出(`src/cli/doctor.ts`)。
- **UI**:dashboard hero 区加「测试本机连接」按钮 → 调 probe → 1~2s 出确定结论并刷新三态。

### 3. 修假绿:hero 改由三态驱动

`dashboardHero` 不再用 `daemon.alive || accountCount>0`。新签名接收 `{ daemonAlive, accountCount, expired, lastUpdateOkAt, lastProbe }`(`expired` 来自现有 session-state /health),映射到上面三态。`taken_over` 时**不**显示"正在尝试恢复陪伴",改显终态文案 + 「重新扫码绑定」按钮(复用 wizard wechat step 跳转,见 `wizard.spec.ts` 的 `add-account-btn` 路由)。

### 4. 方案2(附带):心跳显示

- `src/daemon/poll-loop.ts`:每次 getUpdates **成功**(非 expired、非 error)时记 `lastUpdateOkAt = now`(每账号一条)。
- 通过 `/v1/health` 暴露 `lastUpdateOkAt`。
- `connected` 态下用现有 `formatRelativeTime` 显示"上次活动 {X} 前";`taken_over` / `recovering` 态**不**显示陈旧心跳。
- 注意:心跳是被动启发式,**不作为判定依据**(idle bot 可能也"成功"收空轮询)。判定以三态模型为准,确定结论以方案1 探测为准。

### 5. 终态不再循环探测

收到 `-14` 后锁定 `taken_over`,**停止自动重探**(poll-loop 已 `break`;不新增定时重探)。只有两种方式离开终态:
- 用户点「测试本机连接」手动再探(若那台已下线、本机重新可连,会显示 `connected`);
- 用户重新扫码绑定成功 → 清除该账号的 expired 记录(`session-state` 需在 rebind 成功时 clear)。

## 错误处理

- probe 网络异常(非 -14):`inconclusive`,保持原 state,提示重试。不污染终态。
- probe `-14`:复用 `markExpired`,与被动循环检测同一真相源,避免两套状态打架。
- rebind 成功:清除 expired,使 hero 能回到 `connected`/`recovering`。

## 测试

- **单元**:`dashboardHero` 三态映射(扩展 `apps/desktop/src/view.test.ts`);probe 结果→state 映射(-14→taken_over、success→connected、error→inconclusive)。
- **e2e(shim)**:`overview.spec.ts` 扩展——seed 三种状态,断言 hero 文案 + 「测试本机连接」/「重新扫码绑定」按钮存在与否;`mock.js` / `test-shim.ts` 加 probe 路由 mock。
- **手动实测**:本机非 owner → probe 应得 `-14`(已验证 ✓);**待补**:在 owner(公司)机器上跑 probe,确认无 -14 / 长轮询挂起 = `connected`(验证正向用例)。

## 待验证(诚实标注)

`-14` 作为"非 owner"信号已实测可靠且快。但"无 -14 即 connected"依赖 ilink 对**多端同时长轮询**的语义(是否允许两端各持独立 cursor 而都不 -14)。需在 owner 机器上补一次正向实测确认;若发现多端可共存不报 -14,则正向判定需加额外条件(如比对 `lastUpdateOkAt` 是否真的在推进)。

## 涉及文件

- `src/daemon/poll-loop.ts` — 成功 poll 记 `lastUpdateOkAt`
- `src/daemon/session-state.ts` — 存 `lastUpdateOkAt` / `lastProbe`(或新增 connection-state 小存储);rebind 时 clear expired
- `src/daemon/internal-api/routes.ts` — 新增 `/v1/connection/probe`;`/v1/health` 暴露连接态
- `src/cli/doctor.ts` — doctor 含连接态;新增 `connection probe` 子命令
- `apps/desktop/src/view.js` — `dashboardHero` 改三态
- `apps/desktop/src/modules/dashboard.js` — 渲染三态 + 两个按钮
- `apps/desktop/src/main.js` / `api.js` / `ipc.js` — 接通 probe 命令
- `apps/desktop/src/mock.js` / `apps/desktop/test-shim.ts` — probe mock

## 非目标(YAGNI)

- 不做跨设备的"全局看板"(ilink 无此能力,需自建协调层,超范围)。
- 不做自动抢占/自动重连接管(被接管是终态,刻意要求用户显式重扫,避免两台机器互相踢)。
