# wechat-cc desktop v0.4.2

Two small but visible UX fixes on top of v0.4.1.

## What's fixed

### **「安装并启动」按钮没反馈**
The full install flow takes 5–10 s (foreground-daemon guard +
`service install` invoke + 8 s daemon-settle wait). v0.4.1 left the
button enabled and label unchanged through all of that — users clicked,
saw nothing change, and assumed the GUI froze. v0.4.2 disables the
button immediately on click and changes the label to **安装中…**;
restores the original on completion or failure. Same treatment for the
**停止中…** path.

### **iPhone-frame chat had a stray horizontal scrollbar**
The `.phone-chat` container set only `overflow-y: auto`. CSS spec rule:
when one axis is non-`visible`, the other becomes `auto`. Any child with
intrinsic width past the phone-frame width — a long unbreakable URL,
the slightly-too-wide file-card (220 px min vs the 70 % bubble cap), a
code-block-rendered-as-text — triggered a thin horizontal scrollbar at
the bottom of the chat area inside the iPhone replica. Now explicit
`overflow-x: hidden`, plus `overflow-wrap: anywhere` on `.wechat-bubble`
to break unbreakable strings instead of pushing the bubble past the
frame.

## Install

Same channel as v0.4.1 — download the `.deb` / `.rpm` / `.exe` /
`.msi` / `.dmg` from Releases and install over the previous version.
Linux postinst auto-restarts the systemd `--user` service.

## Verified
- 797 / 797 tests passing
