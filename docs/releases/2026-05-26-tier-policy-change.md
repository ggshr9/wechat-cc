# Behavior change · admin tier strict-mode prompts (RFC 05 Phase 1)

**Date**: 2026-05-26
**Scope**: Tier permission policy. Will fold into the next CLI / desktop release (v0.5.19 / desktop-v0.5.19 once cut).
**Triggered by**: [RFC 05 §7 decision 2](../rfc/05-provider-extensibility.md) + 2026-05-25 dev review finding C4.

---

## TL;DR

Two things change in this release:

1. **Strict-mode admin chats now get a y/n prompt for destructive Bash and `memory_delete`.** Previously v0.5.5 → v0.5.18 silently bypassed all SDK permission gates for any chat in `access.admins`, even when the daemon was launched WITHOUT `--dangerously`. That made the README + CLAUDE.md "strict mode prompts every tool" wording inaccurate and removed a real "are you sure?" guardrail for accidents (Claude misreading a prompt and reaching for `rm -rf`).
2. **`--dangerously` now correctly applies to non-admin chats too.** A non-admin user on a `wechat-cc run --dangerously` daemon previously got `read-only` sandbox on codex + `default+canUseTool` on claude — silently overriding the operator's daemon-wide intent. Now `--dangerously` is a uniform top-level bypass for every chat.

These are two halves of the same underlying refactor (RFC 05): `permissionMode` is now an explicit input to each provider's tier → SDK options translation, not inferred from the shape of the `TierProfile`.

---

## What admins will see

After upgrade, in **strict mode** (daemon launched WITHOUT `--dangerously`):

```
Claude wants to run Bash command=rm -rf /tmp/some-build-artifact
y abc12 / n abc12
```

This prompt routes to the admin themselves (the chat that triggered the tool call, per the multi-admin fix that shipped with v0.5.19 prep). Reply `y abc12` to allow, `n abc12` to deny. 10-minute timeout.

The prompts fire only for **destructive Bash** (`rm`, `git reset --hard`, `git push --force`, `git branch -D`, `dd if=…`, anything matching those patterns including when nested inside `bash -c "..."`) and for **`memory_delete`**. Plain `Bash ls`, `Read`, `Grep`, `Write`, `Edit`, MCP `reply`, `memory_write`, etc. still auto-allow with no prompt.

### To skip prompts entirely

Launch with `--dangerously`:

```
wechat-cc run --dangerously
```

This is the documented opt-in for "I trust everything in this daemon". It now uniformly bypasses sandbox / approval / canUseTool for every chat, including the previously-broken non-admin paths.

---

## What trusted-tier and guest-tier chats see

| Tier (strict mode) | Plain Bash / fs_read | Destructive Bash | `memory_delete` | `a2a_send` | `fs_write` / `Edit` |
|---|---|---|---|---|---|
| **admin** | allow | **relay → admin** | **relay → admin** | allow | allow |
| **trusted** | allow | **relay → admin** | **relay → admin** | **relay → admin** | allow |
| **guest** | **deny** | **deny** | **deny** | **deny** | **deny** |

No change for trusted / guest tiers — only admin's strict-mode prompts are restored.

---

## Codex side

Codex SDK has no per-tool callback, so the policy maps to coarse sandbox + approval:

| Tier | strict permissionMode | `--dangerously` |
|---|---|---|
| admin | `sandbox=workspace-write`, `approval=never` | `sandbox=danger-full-access`, `approval=never` |
| trusted | `sandbox=workspace-write`, `approval=never` | `sandbox=danger-full-access`, `approval=never` |
| guest | `sandbox=read-only`, `approval=untrusted` | `sandbox=danger-full-access`, `approval=never` |

**Behavior change vs v0.5.18**: admin tier in strict mode used to get `sandbox=danger-full-access` via the "admin-tier-equals-dangerously" shortcut. Now strict mode caps admin codex at `workspace-write` — admin codex can still edit files but only inside the project's cwd. Operators who need cross-tree codex writes launch with `--dangerously`.

---

## Cursor side

Cursor SDK has only sandbox on/off. Policy collapses to:

| permissionMode | sandbox |
|---|---|
| strict (any tier) | enabled |
| `--dangerously` (any tier) | disabled |

**Behavior change vs v0.5.18**: admin cursor in strict mode used to get sandbox off (matching the dangerously path). Now it's enabled — admin cursor can only write inside cwd in strict mode. Same `--dangerously` opt-in if cross-tree writes are needed.

---

## For operators who don't want any prompts

Two options:

1. **Daemon-wide bypass**: `wechat-cc run --dangerously`. Affects every chat; no prompts ever.
2. **Per-chat workaround** (not recommended): no per-chat exemption mechanism exists. The two-tier (strict / dangerously) flag is daemon-wide by design — `access.admins` controls *who can give commands*, not *whether prompts fire*.

If you find the destructive-Bash prompt rate too high, file an issue with the specific commands that triggered it. The regex set in `src/core/user-tier.ts:DESTRUCTIVE_BASH_PATTERNS` deliberately errs on over-triggering (it adds `'` and `"` to the trigger character class so `bash -c "rm -rf"` isn't bypassed) — tightening it is a policy call.

---

## Migration

No config changes required. The behavior is purely the daemon's permission-relay layer; `access.json` shape is unchanged. First inbound after upgrade will reflect the new policy.

If you previously relied on admin chats running destructive commands without confirmation, switch to `--dangerously` at boot.

---

## What this unblocks

RFC 05 Phase 1 also restructures provider `spawn()` to take a uniform `SpawnContext` (with `permissionMode` as an explicit field). This eliminates the abstraction leak that caused C4 + C5 + sweep#6 (the three tier-policy regressions surfaced in the 2026-05-25 dev review) and reduces the cost of adding gemini-cli / future providers — a new provider drops in without daemon-side import / matrix edits beyond its own file. RFC 05 Phase 2 (capability matrix derivation) is a follow-up PR.
