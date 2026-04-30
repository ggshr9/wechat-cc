# wechat-cc desktop v0.4.5

New: **网络守护 (Network guard)**.

## What it does

For users behind a VPN to reach Anthropic / Google APIs (i.e. anyone
in mainland China). When VPN drops, the daemon's `claude` subprocess
hits cryptic timeouts and the user gets no reply — but also no signal
about *why*. Network guard catches this fast and surfaces it cleanly.

```
toggle ON → daemon polls public IP every 30s (ipify)
  → IP changed since last tick? probe google.com (HEAD, 3s timeout)
    → unreachable? sessionManager.shutdown(), state = DOWN
    → next inbound message → daemon doesn't spawn Claude, replies:
       "🛑 出口 IP <x.y.z.w> → 网络探测失败。VPN 掉了？修好再发。"
```

Recovery is automatic — when IP changes again and the next probe
succeeds, state flips UP and the next inbound message spawns Claude
fresh. No proactive push when state flips DOWN — only nag when the
user is actively trying to use the bridge.

## Why it's polite

- **Probe target**: google.com `/generate_204` (Google's official
  connectivity-check endpoint, no payload). Probing api.anthropic.com
  on a fixed cadence would be louder and might hit rate-limit budgets;
  Google is the safer canary.
- **Probe frequency**: only when public IP changes. VPN connection
  state always changes egress IP, so IP is the real signal —
  background probing every 30s would be wasteful.
- **Default OFF**: new installs don't get auto-blocked. Opt in via
  the dashboard service screen toggle, or `wechat-cc guard enable`.

## CLI

```bash
wechat-cc guard status        # current IP + reachability + enabled state
wechat-cc guard status --json # structured for scripting
wechat-cc guard enable
wechat-cc guard disable
```

## Frontend

Service screen, alongside「开机自启」/「自动同意工具调用」:

```
网络守护 · Network guard
每 30 秒查公网 IP；变了就探一次 google.com。不通时关闭 Claude
session，下条入站发"VPN 掉了"。           IP 1.2.3.4 · google ✓  [●]
```

Status pill auto-updates when toggling and on entering the service
step.

## Verified

- 808 / 808 tests passing (+5 guard scheduler + 2 CLI parse)
- Live CLI smoke: `guard enable` writes `~/.claude/channels/wechat/
  guard.json`, `guard status --json` returns full structured snapshot
  with current public IP + probe ms.
- onStateChange + sessionManager.shutdown wiring inspected — Claude
  child processes are killed within one poll tick of network DOWN.
