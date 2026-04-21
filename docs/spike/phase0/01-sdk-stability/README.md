# Spike 1: Bun + Claude Agent SDK Headless Stability

**Phase**: 0 · Spike
**Goal**: validate the core architectural bet for the wechat-cc rebuild — that
`@anthropic-ai/claude-agent-sdk` running on Bun can start a headless Claude
Code session **without any interactive dialog** on Windows/macOS/Linux.

If this passes on Windows, the whole Agent-SDK rebuild path is green-lit.

## Run

Requires: Bun 1.1+, Claude Code 2.1+ (with an authenticated claude.ai session).

```bash
cd docs/spike/phase0/01-sdk-stability
bun install
bun spike.ts
```

## Pass criteria

- Process exits within ~60s with code 0
- **No interactive dialog appears** (no workspace-trust, no dev-channel, no tool permission)
- Console logs show `[spike] PASS ✅`
- `assistant` message contained the sentinel `SPIKE_OK`

## Fail modes to watch for

| Symptom | Means |
|---|---|
| Any dialog shown | Headless mode still triggers prompts — architectural bet invalidated, need to investigate permissionMode / flags |
| `query()` throws immediately | SDK cannot find claude CLI, or Bun executable detection broken — fix or fall back to Node |
| Hangs >60s | stream-json stuck somewhere — likely Bun-SDK interop issue |
| Result but no sentinel | Claude responded but not headlessly steerable — unlikely but worth noting |

## Record findings here

After running, append observations below in a table — fill in before running on other platforms.

| Platform | Bun | Claude | Dialog? | Exit code | Notes |
|---|---|---|---|---|---|
| win32 x64 | 1.3.13 | 2.1.116 | **No** ✅ | 0 | 15.4s total, 6 msgs, $0.16 Opus. sentinel hit. |
| macOS | — | — | — | — | pending |
| Linux | — | — | — | — | pending |

### 2026-04-21 Windows run — full log

```
[spike] platform: win32 x64
[spike] runtime: bun 1.3.13
[spike] [11406ms] msg #1: type=system
[spike] [11408ms] msg #2: type=system
[spike] [11424ms] msg #3: type=system
[spike] [14498ms] msg #4: type=assistant
[spike] [14719ms] msg #5: type=rate_limit_event
[spike] [14721ms] msg #6: type=result
assistant txt : "SPIKE_OK"
result.session_id    : 3255d170-8b30-4449-9661-e78f200b4711
result.num_turns     : 1
result.total_cost_usd: 0.16112375
result.duration_ms   : 3304
[spike] PASS ✅
```

**Verdict**: Windows architectural bet validated. **No workspace-trust, no dev-channel, no permission dialog**. The whole rebuild plan is green-lit.

**Observations**:
- Startup overhead ~11s (3 system messages before first assistant turn) — acceptable, but session pool should prefer lazy spawn + keep-alive
- Default model = Opus at $0.16/turn is expensive for testing; later spikes should pass `model: 'haiku'` or similar
- Three `system` messages before assistant; worth reading them later to understand init sequence (for companion layer hooks)

## Next

If PASS on all three platforms → proceed to Spike 2 (session pool overhead).
If FAIL on any → document specific failure mode, iterate on options before continuing.
