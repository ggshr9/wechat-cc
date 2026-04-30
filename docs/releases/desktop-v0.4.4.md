# wechat-cc desktop v0.4.4

A small UX patch for the env-check wizard. Surfaced in v0.4.x by a
real conversation: a fresh user with no Claude binary installed sees
all-red checks, clicks 安装并启动, the daemon registers + starts —
and every WeChat reply silently dies because the SDK can't spawn
`claude`. Top-banner copy "any missing item, can continue, fix later"
made things worse — not all reds are equally fixable later.

## What's new

### Per-row fix hints

Every red check in the wizard now shows a one-line fix beneath it:

- **Claude / Codex / Provider missing** → monospace install command
  with a 复制 button + a small `↗` link to the official install docs
- **微信账号未绑定 / Allowlist 空** → action sentence ("点上方「绑定微信」扫码")
- **Bun missing** (rare on v0.4 since the compiled binary doesn't
  need it at runtime) → install one-liner

No expanding panels, no help-bubbles. One line under each row, copy
the command, click and you're done.

### Install button gate

`安装并启动` now refuses (inline, no popup) when the active agent
backend is missing. The button doesn't get visually disabled — it
just answers in `service-summary`:

> 先装 Claude Code — daemon 起来后无法工作。复制上方命令即可。

Why: registering the systemd unit succeeds, daemon starts, but every
inbound message dies in `provider.spawn(claude)`. Pretending success
is the worst failure mode. Soft reds (no bound account, allowlist
empty) DON'T block — those can be fixed any time after install.

Severity classification lives in `doctor.ts`:
- **hard** = selected agent backend missing
- **soft** = everything else

The classification flips automatically when you `wechat-cc provider
set codex` — Codex becomes hard, Claude becomes soft.

## What we deliberately didn't do

- No streaming CLI output during install. The full flow is ~500 ms
  CLI + ~5 s daemon-settle wait — streaming the CLI half doesn't
  help see what's happening in the second half.
- No confirm dialog. The block is inline, in the same place as
  success copy would land. Clicking again after fixing the red row
  just works.
- No new top-banner. The fix lines speak for themselves.

## Verified

- 801 / 801 tests passing (+2 new severity-classification regressions)
- Playwright e2e against the local shim: 5 fix divs render with
  correct command/action/link split for a synthetic hard-red report;
  install gate fires the inline message exactly once with no
  side-effect on doctor / SDK.
