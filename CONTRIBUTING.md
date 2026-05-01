# 给协作者的小手册

仓库公开，欢迎 fork-PR；下面这套是**有写入权限的协作者**走的流程。

## 一句话工作流

```
git checkout master && git pull           # 永远从最新 master 起
git checkout -b feat/<your-thing>          # 切个分支
# 写、改、测
bun run test
git push -u origin feat/<your-thing>
gh pr create                                # 或在 GitHub UI 开 PR
# 等 review + CI 全绿 → squash merge → 分支自动删
```

主分支 `master` 受保护：**直推会被拒绝**，必须走 PR。
1 个 reviewer 批准 + 三个 CI（Linux/macOS/Windows）全绿才能 merge。

## 分支命名

- `feat/<topic>` — 新功能 / 改进
- `fix/<topic>` — bug 修复
- `docs/<topic>` — 文档
- `refactor/<topic>` — 不改行为的重构

不强制，但帮 reviewer 一眼分类。

## Commit message

[Conventional commits](https://www.conventionalcommits.org/) 风格：

```
feat(daemon): hot-reload accounts on SIGUSR1
fix(desktop): pipe truncation when sessions read-jsonl > 8 MB
docs(readme): drop AppImage from quick-start (CI doesn't build it)
```

PR 走 squash merge，最终进 master 的就是**单条** commit message。
所以 PR 标题要写好——它就是 squash 后的 commit。

## PR 描述

模板会自动出来。重点是 **Why**，不是 **What**——diff 已经告诉 reviewer 改了什么。

## 用 AI 写代码？

完全 OK，但有 4 个常见坑要注意：

1. **AI 容易"顺手"改无关代码**——单 PR 单意图，跨模块的改动拆成多个 PR
2. **AI 写的测试很容易只是"看着像测试"**——盯着断言看，特别是 mock 的部分
3. **AI 偶尔会幻觉 API**——`bun run typecheck` 过 ≠ API 真存在；可疑函数名 grep 一下源码
4. **secrets 别 push**——`.env` / API key / token 应在 `.gitignore` 里，别相信 AI 不会粘进 commit

PR 描述里的 "留意" 那一栏，AI 写代码尤其要填——告诉 reviewer 你哪块没把握。

## 试着开个 PR

第一次走流程？拿个简单的开头：

- 改个 typo（`grep -rn TODO docs/` 找一个）
- 加一个 README 翻译 / 修个链接

跑一遍流程，比看说明书有用。

## 卡住了

- CI 红了不知道为啥 → 看 Action 日志，错信息 paste 进 PR 评论，@ggshr9
- merge conflict → `git fetch origin master && git rebase origin/master`，
  解冲突，`git push --force-with-lease`
- 其他 → 在 PR 里直接 @ 提问

仓库的设计原则（功能少 / clean / 不 SaaS 风）请先看一下 [`README.md`](./README.md)。
