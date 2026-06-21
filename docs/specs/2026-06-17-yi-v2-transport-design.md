# 乙 v2 Transport — Design

**Date**: 2026-06-17
**Status**: Design draft (for review; implementation pending)
**Builds on**: A2A integration (2026-05-24), 乙 v1 one-brain-many-hands (`hand invite`/`join`, `/a2a/exec`, `让X执行`), account export/import + takeover (multi-device)
**Reference**: OpenAI Codex `exec-server` wire protocol (ws + JSON-RPC 2.0, rendezvous-ws + Noise relay) — borrowed *patterns*, not the protocol

---

## Goal

Make one-brain-many-hands (乙) work for a **normal user with no Tailscale**, while keeping the power-user (Tailscale-direct) path and adding streaming + resilience. The brain (holds the bot, receives WeChat) dispatches a task — "让公司拿文件", "让家里关灯" — to a hand machine that runs a local agent and streams the result back.

The one physical constraint that shapes everything: **ilink only talks to the active machine; a hand behind NAT is unreachable inbound.** So v2's core move is **outbound-only hands** that connect *out* to a rendezvous the brain also reaches — no inbound port, no port-forward, no Tailscale required.

### What v1 doesn't solve

- **NAT.** v1 has the brain POST `/a2a/exec` *to* the hand → the hand must be inbound-reachable (a Tailscale IP). A normal home/office machine behind NAT can't be reached.
- **Long tasks.** v1 is a blocking HTTP POST — no progress, no streaming; long agent runs sit silent and are fragile to timeouts (we already had to bump client + `idleTimeout` to 255s as a band-aid).
- **Flaky networks.** No heartbeat / reconnect / resume; a dropped connection loses the in-flight task.

---

## Non-goals

- Replacing Codex's `exec-server` (different abstraction — see below). We may *interop* with it for the Codex provider later.
- Running our own global relay infrastructure. v2's default rendezvous is **the always-on brain itself**; a hosted relay is an optional future tier.
- Session takeover semantics (which machine holds the bot) are reused, not redesigned — but v2's persistent channel is a natural carrier for the `切到<name>` control message (see §8).

### Abstraction note (why not just use Codex exec-server)

Codex `exec-server` is **remote process + filesystem control** (`process/start`, `process/read`, `fs/*`): a central agent drives a remote machine as a sandbox. 乙 is **remote *agent task*** ("run a whole agent on this prompt, give me the answer"). Higher level, and the right fit for "让公司拿文件". We borrow exec-server's transport *patterns* (ws + JSON-RPC, init handshake, rendezvous-ws for NAT, end-to-end encryption, heartbeat/ack/resume) but keep our task-level RPC.

---

## Tiers (the product shape)

| Tier | Who | Rendezvous | Tailscale | Notes |
|------|-----|-----------|-----------|-------|
| **0 — single / no always-on machine** | most basic users | — | — | No remote at all. "Scan wherever you are." Out of scope for transport. |
| **1 — home brain as rendezvous** (default multi-machine) | one always-on machine (home) | the brain itself, exposed via a tunnel (cloudflared — already a dep) | **no** | Hands connect outbound to the brain. Home tasks (smart-home, home files) need *zero* extra networking — WeChat already reaches the brain through ilink. |
| **2 — Tailscale direct** | power users | none (direct ws) | yes | Lowest latency, fully private, no relay. v1 push mode also remains valid here. |
| **3 — hosted relay** (optional, future) | users who want remote but have no always-on brain | a hosted rendezvous | no | Only viable because of E2E encryption (§6): the relay can't read tasks. A real infra/privacy/cost decision — deferred. |

The same code path serves tiers 1–3; only the **rendezvous URL** differs (brain-tunnel / tailnet / hosted).

---

## 1. Topology & roles

- **Brain** — holds the bot (ilink long-poll, outbound), receives WeChat, dispatches tasks, relays results. In tier 1 it is *also* the rendezvous.
- **Hand** — runs a local agent on dispatched tasks. **Always the connection initiator** (outbound), in every tier — one code path, NAT-friendly everywhere.
- **Rendezvous** — a `wss://` endpoint both brain and hand reach. Tier 1: the brain behind a cloudflared tunnel. Tier 2: the brain's direct tailnet ws. Tier 3: a hosted relay.

Because the hand initiates, the persistent ws is bidirectional: brain pushes tasks *down*, hand streams results *up*.

---

## 2. Transport: WebSocket + JSON-RPC 2.0

- `wss://` (TLS; cloudflared/tailnet give it for free), **one JSON-RPC 2.0 message per frame**.
- **Init handshake, per connection** (borrowed from Codex):
  1. Hand → `initialize` `{ handId, clientName, capabilities, authToken }`
  2. Brain → result `{ sessionId, resumeTtlMs }`
  3. Hand → `initialized` notification
  - Any other traffic before `initialized` → error (request id `-1`).
- After init, the connection is a live duplex channel until closed.

---

## 3. Message protocol (task-level RPC)

**Brain → hand**
- `task/dispatch` `{ taskId, peer: "claude"|"codex", prompt, cwd?, timeoutMs? }` → `{ accepted: true }`
- `task/cancel` `{ taskId }`
- `bot/takeover` `{}` → tells this hand to grab the ilink session (reuses `requestTakeover`; see §8)

**Hand → brain** (notifications)
- `task/progress` `{ taskId, seq, text }` — streaming partial output / status ("正在读 README…")
- `task/result` `{ taskId, ok, response? , reason? }` — terminal
- `task/log` `{ taskId, level, text }` — optional structured logs

**Both**
- `ping` / `pong` (or ws ping frames) — heartbeat, ~15s
- `resume` `{ sessionId, lastAckSeq }` — on reconnect, re-attach (§5)

Errors use JSON-RPC codes (`-32600/-32602/-32603`); overload → `-32001` "retry later" (borrowed).

---

## 4. Auth & pairing

- **Per-hand key** from pairing (reuse `a2a-registry` + `hand invite`/`join`). Sent as `authToken` in `initialize`; brain verifies (constant-time) against the registered hand.
- **Pairing v2** provisions three things into the hand: `handId`, the shared **exec key** (also the E2E key, §6), and the **rendezvous URL** (+ a relay-auth token if tier 3). `hand invite` on the brain prints a code carrying `{ rendezvousUrl, handId placeholder, pairSecret }`; `hand join` on the hand completes it and immediately opens the outbound ws.
- **Relay-auth** (tiers 1/3): the rendezvous authenticates *connection establishment* (so randoms can't squat handId slots / DoS) but never needs the exec key — it can't read task content.

---

## 5. Resilience (borrowed from Codex relay)

- **Heartbeat** — ws ping/pong every ~15s; miss M (e.g. 3) → mark hand offline. WeChat dispatch to an offline hand replies "手「家里」当前离线(没连上来)" instead of a silent failure.
- **Seq + ack** — `task/progress`/`task/result` carry `seq`; brain acks; hand buffers un-acked frames and replays after reconnect. Results are never lost to a blip.
- **Resume** — `initialize` returns a `sessionId` with a `resumeTtlMs`. On reconnect within TTL, hand sends `resume { sessionId, lastAckSeq }`; brain re-attaches in-flight tasks and replays un-acked results rather than restarting.
- **Idempotency** — `taskId`-keyed; a re-dispatched taskId is deduped by the hand (so a brain-side retry can't double-run an agent).

---

## 6. End-to-end encryption (the relay can't read your tasks)

The rendezvous (brain-tunnel in tier 1, hosted in tier 3) is treated as **untrusted transport**. Task payloads (`prompt`, `response`, logs) are encrypted **before** they hit the ws.

- **v2.0 — shared-key AEAD.** The exec key shared at pairing seeds a symmetric key; each frame is AES-256-GCM with a per-frame nonce. Relay sees only `{ handId, frame sizes, timing, ciphertext }`. Simple, ships first.
- **v2.x — Noise handshake** (forward secrecy, like Codex's relay). Upgrade path; heavier. Note as future.

Cleartext over the ws is limited to routing metadata (`handId`, `sessionId`, seq/ack, heartbeat). The brain↔hand task content is opaque to any relay.

> This directly answers the earlier objection "won't a relay see my commands?" — with E2E, no. It's what makes tier 3 (and a brain-as-relay multiplexing several hands) acceptable.

---

## 7. NAT traversal, concretely (tier 1)

1. Brain runs the ws rendezvous on `127.0.0.1:<port>` and exposes it via **cloudflared** (already used for `share_page`) → a stable `wss://<random>.trycloudflare.com` (or a named tunnel).
2. `hand join <code>` on the office machine reads the rendezvous URL from the code, opens an **outbound** ws to it, `initialize`s, and parks on the connection.
3. WeChat "让公司拿文件" → brain `task/dispatch` down the live ws → office hand runs the agent locally → streams `task/progress`/`task/result` up → brain relays to chat.
4. The office hand **never opens an inbound port**; exec happens locally on the office machine. The brain's single tunnel multiplexes all hands by `handId`.

Home tasks need none of this: the brain *is* the home machine, reached via ilink.

---

## 8. Unifying with takeover (`切到<name>`)

The persistent ws is also the channel for "switch which machine holds the bot" (the earlier multi-device ask). Brain → hand `bot/takeover` over the live ws → hand runs the existing `requestTakeover` (SIGUSR1 → re-poll ilink) → it grabs the session, the previous holder gets errcode=-14 and stands by. So `切到家里` / `切到公司` from WeChat works for any *connected* hand — no Tailscale beyond what the task channel already needs. (A hand must be ws-connected to be takeover-able remotely; offline → "它没连上来".)

---

## 9. Backward compatibility

- **v1 push mode stays.** Registry entries gain `transport: "push" | "ws"`. Direct-reachable hands (Tailscale/LAN) may keep `/a2a/exec` push as a low-latency option; everyone else uses ws.
- v1 `hand add`/`accept` and `hand invite`/`join` continue to work for push; v2 pairing adds the rendezvous URL + ws.
- `让X执行` dispatch resolves the hand, then routes by its `transport`.

---

## 10. Security model

- **Exec key = remote-agent-exec credential (RCE)** — unchanged threat from v1, now *also* the E2E key. Pair only over a trusted moment; rotate via re-pair.
- **Relay untrusted** — E2E (§6) keeps content private; relay-auth (§4) prevents slot-squatting/DoS.
- **Sandbox posture surfaced** — the review flagged that the Claude exec path is effectively auto-allow (Bash/Write), while Codex is read-only-sandboxed. v2: the hand declares its sandbox policy in `initialize.capabilities`; the brain records it and can show "家里(可写) / 公司(只读)" so the operator sees the blast radius. Consider defaulting Claude hands to an allowlisted/read-mostly posture.
- **wss everywhere** — TLS via cloudflared/tailnet.

---

## 11. Phases

1. **ws task channel** — ws + JSON-RPC + init handshake + `task/dispatch`/`task/result` (no streaming, no relay). Hand connects outbound directly to the brain (tailnet, or brain+tunnel). Replaces the blocking HTTP POST. *Smallest shippable win.*
2. **Streaming + resilience** — `task/progress`, heartbeat, seq/ack, resume.
3. **E2E (shared-key AEAD)** — encrypt task payloads.
4. **Brain-as-rendezvous (tier 1)** — cloudflared tunnel integration, multi-hand multiplexing by handId, offline detection in WeChat replies, `bot/takeover` over the channel.
5. **Optional** — hosted relay tier; Noise upgrade; Codex `exec-server` interop for the Codex provider.

---

## 12. Open questions

- **Relay = brain-tunnel vs tiny dedicated binary?** Brain-tunnel is zero new infra (reuse cloudflared); a dedicated relay is cleaner for multiplexing but is new code. Lean brain-tunnel for v2.
- **cloudflared URL discovery** — named tunnel (stable URL, needs a Cloudflare account) vs quick tunnel (random URL, must be re-shared on restart). Probably named for an always-on brain.
- **AEAD vs Noise for v2.0** — start AEAD (simpler), note Noise as the forward-secrecy upgrade.
- **Keep HTTP push at all?** Recommend: yes, as the Tailscale-direct fast path; ws elsewhere.
- **Heartbeat/timeout/resume-TTL tuning.**
- **Multiple brains?** Out of scope; one brain per bot token.
