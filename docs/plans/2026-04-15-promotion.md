# wechat-cc 推广方案

_2026-04-15 · 参考用，不是承诺要做_

这份文档是跟顾时瑞讨论出来的推广思路，主要回答「如果要推广 wechat-cc 应该怎么做」这个问题。**不是营销计划，是一份低调扩散的 playbook**。里面的每一条都可以单独挑着做，互相不依赖。

---

## 一、前置判断

### 1.1 三道硬门槛

无论什么动机都绕不开这三条约束，推广策略必须围着它们转：

**合规灰区**

ilink bot API 不是微信官方接口，用 ilink 做自动化可能触犯 WeChat ToS 的「禁止未经授权的自动化」条款。账号被风控的风险存在（历史上 wechaty、ipad 协议类项目都经历过封控潮）。

推广广了反而更容易上雷达。核心原则：**让真想用的人找到，但不要营销式扩散**。

**目标受众极窄**

wechat-cc 的用户必须同时满足：

- 装了 Claude Code CLI（绝大多数中国开发者并没有）
- 愿意装 bun + git + 理解 MCP 概念 + 扫码绑定
- 有真实的「移动端长跑任务监督」「非技术人审阅」或「多人协作微信指挥 Claude」需求
- 在中国区（否则 Anthropic 官方的 Telegram channel plugin 就够了）

这个交集规模估计在**几千到几万人**，不是百万。

**无官方背书**

Anthropic 官方已经有 Telegram channel plugin。wechat-cc 做的是官方不会做、不会收录、不会上 showcase 的 niche。

- 优势：没有官方竞品
- 劣势：Google 搜不到，Claude Code docs 不会提到，Anthropic 不会 tweet 转发

### 1.2 动机决定策略

在动手之前先问：**为什么要推广？** 不同动机对应完全不同的路径：

| 动机 | 最佳渠道 | 成功指标 |
|:---|:---|:---|
| 吸引 contributor | GitHub + 技术博客 + 精准社群 | PR 数 / Issue 质量 |
| 让更多中文 Claude Code 用户用上 | 知乎/掘金技术长文 + README GIF | install 量（难测） |
| 验证 PMF（有没有人真需要） | HN / X 一次性发布 | 回复里的「我也需要这个」 |
| 个人作品集 / 简历 | 低调发布 + README 漂亮 | 面试时能讲清楚 |
| 帮朋友/公司找同类需求的人 | 内部渠道 + 微信好友发链接 | 真实使用人数 |

**默认假设**：动机是 2 或 3（扩散到有需求的开发者 + 验证需求）。下面的策略按这条路写。

---

## 二、Pre-launch 必做检查

### 2.1 README 升级清单

- [ ] **顶部加明确 disclaimer**：
  > ⚠️ 本项目使用非官方的 ilink bot API。使用者应了解这可能违反 WeChat ToS，账号被限风险自担。**不得用于商业**。
- [ ] **What can you do now?** 段落用 2-3 个具体场景代替功能列表：
  > - 出门在外想让 Claude 重构一个模块，电脑跑在家里，你用微信指挥
  > - Claude 写完一份 plan，手机上点开链接看渲染好的 markdown，点 Approve
  > - 非技术同事通过微信给你的 Claude 发指令（access control 白名单管理）
- [ ] 顶部加一个 30s 的 demo（video/GIF/静态拼图，三选一，见第四节）
- [ ] 移除任何形式的「N 人在用」营销语（目前没有，继续保持）
- [ ] Features 列表精简，重点突出 share_page / resurface_page / approve 这些有差异化的特性
- [ ] Installation 段落更友好，或者保留技术门槛作为自然筛子

### 2.2 License / 元信息

- [ ] License 保持 MIT（已有）
- [ ] package.json / plugin.json 里不绑定公司邮箱、真名
- [ ] GitHub 仓库的 owner 是个人账号不是公司组织
- [ ] Issues + Discussions 打开，让感兴趣的人能找到路径

### 2.3 切断个人信息的可追溯性

- [ ] Commit 里不出现真名、工号、内部系统名（目前也干净）
- [ ] Repo 里不留 CLAUDE.md / 个人 memory / 调试日志（gitignore 已经覆盖）
- [ ] 发布的博客不署真名（可用 handle）

---

## 三、发布渠道分级

### 3.1 推荐（一次性，低调）

**一篇技术长文投一个平台**（只选一个，避免广撒网）：

- **知乎「开发工具」话题**：中文开发者密度高，长文友好
- **掘金「AI 编程」专栏**：中文技术社区，标签精准
- **Medium / Dev.to**：英文受众，适合 global Claude Code 用户

文章要求：

- 标题不要营销腔。反面：「我用 Claude Code + 微信搞了个炸裂黑科技」。正面：「给 Claude Code 加一个 WeChat channel：我踩的坑和最终的架构」
- 内容 80% 技术细节（MCP 协议 / ilink 长轮询 / cloudflared tunnel / expect 自动化），20% 场景
- **不要发评论区煽动**，让自然流量带
- 文末挂 GitHub 链接和 disclaimer，不留联系方式

**GitHub README**：把做好的 demo 放顶部，其余按上面 2.1 升级。

### 3.2 可选（精准投放）

- **HN（news.ycombinator.com）Show HN**：一次性，国际技术读者。注意标题：`Show HN: wechat-cc – bridge Claude Code sessions to WeChat`。风险：评论区会问「为什么不做 Telegram/Slack」，要准备回答
- **X / Twitter**：英文技术圈，中文用户基本不在这，发不发边际

### 3.3 不推荐

- 🚫 **小红书**：触达泛用户，合规风险高，不对口
- 🚫 **B 站视频**：制作成本高，目标观众匹配度低
- 🚫 **抖音 / 视频号**：同上，且更公开
- 🚫 **微信群推广 / 朋友圈大面积扩散**：上风控最快的路径
- 🚫 **付费推广 / influencer 合作**：完全不合适
- 🚫 **主动对标 Anthropic 官方渠道**：ilink 灰区过不了审，反而可能招惹注意
- 🚫 **向 Claude Code plugin marketplace 提交**：见上

---

## 四、Demo 录制方案

三个递进的选项，按投入从高到低：

### 4.1 方案 A：30 秒双屏 MP4（最贵，最好）

#### Storyboard

| 时间 | 画面 | 关键信号 | 字幕 |
|:---:|:---|:---|:---|
| 0-3s | 标题卡，仓库名 + 一句话描述 | 品牌 | `wechat-cc · WeChat channel for Claude Code` |
| 3-8s | 终端：`wechat-cc setup` → QR 码渲染 | 扫码即用 | `一次扫码绑定` |
| 8-12s | 手机：WeChat 扫码 → 「已与微信连接」 | 扫码成功 | — |
| 12-15s | 终端：`wechat-cc run` 起来，MCP channel loaded | 启动 | — |
| 15-19s | 手机：发 "帮我写个 Bun hello world"，终端显示 Claude 接收 | 双向 | `手机发，Claude 收` |
| 19-24s | 终端：Claude 响应 + 调 `share_page` → 生成 URL | 产出 | `长内容自动发网页` |
| 24-28s | 手机：点开 share_page URL 看到渲染好的 markdown + 底部 Approve 按钮 | 交互 | `手机端渲染 + 一键审阅` |
| 28-30s | 收尾：Logo + GitHub URL + disclaimer 脚注一行 | CTA | `github.com/ggshr9/wechat-cc` |

每个镜头要干净 —— 不要多余的终端 prompt、浏览器 tab 栏、通知弹窗。

#### 录制命令栈

**Mac + iPhone**：

```bash
# 终端录制：QuickTime → File → New Screen Recording → 框选 Terminal 窗口
# 手机录制：USB 连 iPhone → QuickTime → File → New Movie Recording → 点相机旁下拉选 iPhone

# 假设导出了 terminal.mov 和 phone.mov，开始拼接
# 1) 统一帧率和分辨率
ffmpeg -i terminal.mov -vf "fps=24,scale=960:-1:flags=lanczos" terminal.mp4
ffmpeg -i phone.mov     -vf "fps=24,scale=540:-1:flags=lanczos" phone.mp4

# 2) 水平拼接（左终端，右手机）
ffmpeg -i terminal.mp4 -i phone.mp4 \
  -filter_complex "[0:v]pad=iw+540:ih:0:0:color=black[left];[left][1:v]overlay=960:0" \
  -an combined.mp4

# 3) README 直接用 MP4（GitHub 支持 <video> 标签）
# 放到 docs/media/demo.mp4 然后 README 里：
# <video src="docs/media/demo.mp4" autoplay loop muted></video>
```

**Linux + Android**：

```bash
# 终端录制：ffmpeg x11grab
ffmpeg -f x11grab -framerate 24 -video_size 1280x720 -i :0.0+100,100 terminal.mp4

# 手机录制：scrcpy（USB 调试开启）
scrcpy --max-size 800 --record phone.mp4

# 拼接 + 同上
```

**转 GIF（如果非要 GIF）**：

```bash
ffmpeg -i combined.mp4 -vf "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 demo.gif
# 30 秒 12fps 800px 宽大概 2-4MB
```

**投入估计**：录 2-3 次拿满意的，30-60 分钟。

### 4.2 方案 B：终端侧 asciinema（简化版）

只录终端，不涉及手机。好处：文件小（~100KB）、可暂停复制文字、录制 1 次搞定。坏处：看不到手机端，产品价值的一半是隐的。

```bash
# 录制
asciinema rec demo.cast
# 跑 wechat-cc setup / run / /status / update 等，Ctrl+D 结束

# 转 SVG（动画）
npx svg-term --in demo.cast --out demo.svg --window --width 80 --height 24

# 或者转 GIF
# 装 agg（asciicast → gif）
cargo install --git https://github.com/asciinema/agg
agg demo.cast demo.gif
```

**投入估计**：15 分钟。

### 4.3 方案 C：静态 4 格拼图（最省事）

比 A 省 90% 时间，效果八成（README 里大部分人是扫一眼）。

**4 张截图**：

1. 终端 `wechat-cc run` 刚起来的画面（标志性：tunnel URL + `wechat channel: N account(s) loaded`）
2. 手机 WeChat 里收到 bot 的第一条消息（可以是你自己发 `/ping` 得到 `pong` 的截图）
3. share_page 在手机浏览器里渲染的 markdown（代码块 + 表格 + approve 按钮）
4. 终端 `/status` 的返回（版本号 + 更新状态）

**拼成 2×2**：

```bash
# ImageMagick 拼接，各截图都 cropped 到相同宽高
magick convert terminal-run.png wechat-msg.png +append top-row.png
magick convert share-page.png terminal-status.png +append bottom-row.png
magick convert top-row.png bottom-row.png -append demo.png

# 或者 ffmpeg：
ffmpeg -i terminal-run.png -i wechat-msg.png -i share-page.png -i terminal-status.png \
  -filter_complex "[0:v][1:v]hstack=inputs=2[top];[2:v][3:v]hstack=inputs=2[bot];[top][bot]vstack=inputs=2" \
  demo.png
```

**投入估计**：10 分钟（截图 5 分钟 + 拼接 5 分钟）。

### 4.4 推荐

- **如果认真要发一次博客 + README**：做方案 A 的 30s MP4，投入值得
- **如果只想让 README 不那么空**：做方案 C 的静态拼图
- **方案 B 单独使用不推荐**（隐藏了产品的一半），只适合作为补充的「命令行截图」

---

## 五、发布顺序（如果真的要推）

```
Day 0: 准备
  - README 按 §2.1 升级
  - 录好 demo（方案 A / C 二选一）
  - 添加 disclaimer
  - 切断个人信息

Day 1: 发布
  - 写一篇技术长文，投一个平台（知乎/掘金/Medium 三选一）
  - 文末挂 GitHub 链接
  - 不在评论区自我宣传

Day 2-7: 观察
  - GitHub star / fork / issue 趋势
  - 技术博客评论区的真实反馈
  - 别人自发转发的路径

Day 8+: 按反应决定
  - 有 contributor → 开始做 pending senders / doctor / 其它 Tier 2 改进，保持势头
  - 没人要 → 回归个人使用，不再推
  - 有 abuse 信号 → 立刻撤
```

---

## 六、风险控制

### 6.1 合规风险

- **不要在文章里鼓吹「合法」或「官方」**，disclaimer 写清楚
- **不要公开的案例**：用户具体使用场景里如果涉及私人微信对话，公开样例要脱敏
- **如果收到 WeChat / 腾讯的通知**：立刻把 repo 设为 private，README 加 sunset 通知，不要硬撑
- **不要承接商业需求**：有人来问「我们公司想买你的服务」→ 礼貌拒绝，这种合作会让责任主体化

### 6.2 滥用风险

wechat-cc 本质上是一个「能通过 MCP 接收消息的 WeChat bot」。坏人可以用它做：

- 群发垃圾（有 broadcast 工具）
- 自动化回复服务类业务（商业灰产）
- 骗局中间层

缓解：

- README 里显式写「用于个人/小团队开发场景；禁止商业用途」（MIT 允许但 readme 表态）
- 不接受针对 abuse 场景的 feature request
- 不开放「接入多个微信号批量操作」类功能

### 6.3 技术风险

- cloudflared quick tunnel 是 Cloudflare 免费服务，Cloudflare 哪天限了也活不下去
- ilink API 哪天改了，整个项目就需要紧急适配
- Claude Code 哪天改了 MCP 频道机制（`notifications/claude/channel`），入站 push 会断

**建议**：README 里加一段「已知依赖和失效风险」，让用户心里有数。

---

## 七、后续可选扩展（推广成功后的下一步）

如果推广真的带来了可观的关注，可以按以下优先级做：

1. **wechat-cc 稳定化**：doctor 命令、pending senders 视图、更好的 error recovery（之前 Tier 2 清单）
2. **抽象成 IM-cc 框架**：把 ilink 那层换成 lark（飞书）/ telegram / dingtalk，复用 bindings / router / share_page / approve 这些通用模块。这条就是 sidecar 对比里提到的「两个抽象轴」之一
3. **多 client 支持**：加 `poll_inbox` MCP tool 让 Cursor / Windsurf / Cline 也能接入（仅在有实际需求时做）
4. **更好的 access 管理**：GUI / web UI / WeChat 端的只读 `/access list`

以上**全都不在本次推广的 scope 内**，只是为「如果真的有人要用」留的扩展路径。

---

## 八、我的一票

如果动机是 2（让中文 Claude Code 用户知道有这个）或 3（验证 PMF），我推荐：

1. **今天或明天**：做静态 4 格拼图（方案 C），10 分钟
2. **README 按 §2.1 升级**，加 disclaimer + 3 个具体场景，30 分钟
3. **一周内**：写一篇中文技术长文，投知乎或掘金一次
4. **观察一周**，按真实反馈决定是否深入

动机是其他几条的话，重新讨论。

如果**只是想让几个朋友也用上**，这份方案全部可以跳过，直接发 GitHub 链接给他们就行。

---

## 九、没做的决定

以下这些决定现在还没做，等顾时瑞拍板：

- [ ] 动机是哪一条（5 选 1）
- [ ] demo 方案选 A / B / C / 不做
- [ ] 技术长文投哪个平台（或者不投）
- [ ] 是否发 HN Show HN
- [ ] README disclaimer 的具体措辞
- [ ] 发布时间窗口
