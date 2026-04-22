# VoxCPM2 Deployment — Morning Status (set up 2026-04-22)

## What was deployed last night

- Python 3.13 venv at `~/voxcpm-server/` on `homebot` (Mac mini M4, 16GB, macOS 26).
- `voxcpm` 2.0.2 + `fastapi` + `uvicorn` + `soundfile` installed.
- Wrapper `server.py` exposing OpenAI-compatible `/v1/audio/speech` + `/health`.
- **launchd agent**: `~/Library/LaunchAgents/com.wechat-cc.voxcpm.plist` — autostart on login, `KeepAlive: true` for crash recovery. Logs at `~/Library/Logs/voxcpm.{out,err}.log`.

## What was delivered

A WAV audio file of "晚安" (synthesized with voice descriptor `"年轻女性，温柔甜美，萝莉音色"`) was sent to your WeChat chat. It arrived as a **file attachment** (tap to play) rather than a **voice bubble**. See "Open issues" below.

## Current reachability quirk (macOS 26 Local Network privacy)

VoxCPM2's Python process, when bound to `0.0.0.0` (all interfaces including Tailscale), silently fails to accept external connections. Symptom: `lsof`/`netstat` show it listening, but `curl` hangs with 0 bytes received. Even `curl 127.0.0.1:PORT` on the Mac itself times out when the process is bound to a wildcard address.

Root cause: **macOS 26 added a "Local Network" privacy permission** requirement. A Python process launched via SSH/launchd doesn't get a GUI prompt and is silently dropped by the kernel for non-loopback traffic.

**Workaround in effect right now**: VoxCPM2 is bound to `127.0.0.1:8765` only. The Windows daemon reaches it via SSH port-forwarding:

```powershell
# From Windows (while voice features in use)
ssh -N -L 8765:127.0.0.1:8765 homebot@100.64.249.44
# ...or the helper:
pwsh -NoProfile -File ~/.claude/plugins/local/wechat/scripts/voxcpm-tunnel.ps1
```

`voice-config.json` has `base_url: http://127.0.0.1:8765/v1/audio/speech` so the daemon hits the tunnel transparently.

## Long-term fix (do at the Mac, ~30 seconds)

Grant the Python binary Local Network permission:

1. On the Mac, open **System Settings → Privacy & Security → Local Network**.
2. Toggle **Python** (or the venv's python path `/Users/homebot/voxcpm-server/.venv/bin/python`) to ON. If it's not listed, it'll be prompted on next launch.
3. Edit `~/Library/LaunchAgents/com.wechat-cc.voxcpm.plist`, change `VOXCPM_HOST` from `127.0.0.1` to `0.0.0.0`.
4. `launchctl unload ~/Library/LaunchAgents/com.wechat-cc.voxcpm.plist && launchctl load ~/Library/LaunchAgents/com.wechat-cc.voxcpm.plist`.
5. Update this laptop's `voice-config.json` `base_url` to `http://100.64.249.44:8765/v1/audio/speech` (direct Tailscale).
6. SSH tunnel no longer needed.

## Open issues

1. **WAV arrives as file attachment, not voice bubble.** `src/daemon/media.ts`'s `buildMediaItemFromFile` classifies `.wav` as `UPLOAD_MEDIA_TYPE.FILE` (type 3) → ilink renders it as a file, not a voice bubble. `ilink.ts` defines `MessageItem.type: 3 = voice` with a `voice_item` shape `{text, media, encode_type, bits_per_sample, sample_rate, playtime}`. Need a Spike 4–style experiment to (a) confirm the correct `UPLOAD_MEDIA_TYPE` value for voice uploads (current enum is just `{IMAGE:1, VIDEO:2, FILE:3}`; probably want VOICE:4), (b) figure out the required `encode_type` (likely not raw PCM — WeChat clients typically expect SILK, AAC, or MP3). Candidate follow-up task.

2. **Inference latency**: "晚安" rendered in ~11s. That's long for a 2-character utterance. VoxCPM2 has a `inference_timesteps=10` default; dropping to 5 halves the diffusion cost. Worth experimenting if latency is a pain point.

3. **Cold cache**: the first synth after model load warms caches; subsequent synths are typically faster (~3-5s for short text on M4).

## Files touched on this Windows machine (new, committed to the repo)

- `scripts/send-wanan-voice.ts` — the one-shot script that delivered tonight's message. Usable as a template for future direct-send experiments.
- `scripts/voxcpm-tunnel.ps1` — SSH tunnel helper (run + leave open while using voice).
- `docs/ops/voxcpm2-deployment.md` — this file.

## Files touched on the Mac (ssh homebot@100.64.249.44)

- `~/voxcpm-server/` — Python venv + server.py + start.sh
- `~/Library/LaunchAgents/com.wechat-cc.voxcpm.plist`
- `~/Library/Logs/voxcpm.{out,err}.log`
- `~/.ssh/authorized_keys` gained a pubkey for passwordless access from this Windows.

## Undoing / cleanup (if you want to remove it)

```bash
# On the Mac
launchctl unload ~/Library/LaunchAgents/com.wechat-cc.voxcpm.plist
rm ~/Library/LaunchAgents/com.wechat-cc.voxcpm.plist
rm -rf ~/voxcpm-server
rm ~/Library/Logs/voxcpm.*.log
# Remove claude's pubkey from authorized_keys (grep -v 'claude-overnight-deploy')
```
