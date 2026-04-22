# SSH tunnel from this Windows → Mac (homebots-mac-mini, 100.64.249.44) → VoxCPM2 on 127.0.0.1:8765
# Required because macOS 26's Local Network privacy blocks wildcard (0.0.0.0) binds until
# the user grants the Python binary Local Network permission at the Mac's GUI. Until then,
# VoxCPM2 is bound to 127.0.0.1 on the Mac and reached via this SSH forward.
#
# Keep this window open while using voice features. Ctrl+C to stop.
#
# Alternative (long-term): grant Python "Local Network" permission on the Mac,
# then bind VoxCPM2 to 0.0.0.0:8765 and talk to it directly over Tailscale.
#
# Usage:
#   pwsh -NoProfile -File scripts/voxcpm-tunnel.ps1

Write-Host "Opening SSH tunnel: Windows 127.0.0.1:8765  ->  homebot:8765 (via Tailscale)..."
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L 8765:127.0.0.1:8765 homebot@100.64.249.44
