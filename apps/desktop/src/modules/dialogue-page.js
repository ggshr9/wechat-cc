import { icon } from "./icons.js"

const PRIVATE_PASSWORD = "1234"
const DIALOGUE_ASSET_ROOT = "./assets/dialogue"

const groups = [
  {
    id: "tasks",
    label: "任务",
    icon: "task.svg",
    items: [
      ["codex如何完全控制figma读写功能", "60%"],
      ["简历优化指导", "50%"],
      ["设计自动化在产品开发中的应用", "50%"],
      ["如何通过用户数据驱动设计决策", "50%"],
      ["多平台设计系统的统一管理", "50%"],
      ["提升用户体验的交互设计技巧", "50%"],
    ],
  },
  {
    id: "knowledge",
    label: "知识",
    icon: "knowledge.svg",
    items: [
      ["利用Figma插件优化设计流程", "", ["figma", "插件", "skill"]],
      ["无障碍设计在现代UI中的重要性", "", ["UI", "设计"]],
      ["跨团队协作中的设计规范建立", "", ["设计规范"]],
    ],
  },
  {
    id: "stories",
    label: "故事",
    icon: "story.svg",
    private: true,
    items: [
      ["和花艺师闺蜜的周末", ""],
      ["姐妹聚会计划", ""],
      ["和同事相处", ""],
    ],
  },
  {
    id: "emotions",
    label: "情绪",
    icon: "emotion.svg",
    private: true,
    items: [
      ["糟糕的心情", ""],
      ["自我察觉", ""],
      ["负能量释放", ""],
      ["冥想", ""],
    ],
  },
]

function lockIcon(unlocked = false) {
  return icon(unlocked ? "square-unlock-01" : "square-lock-01", { size: 20 })
}

function avatar(type) {
  const file = type === "ai" ? "ai-avatar.png" : "user-avatar.png"
  const alt = type === "ai" ? "张凌赫" : "锦鲤大人"
  return `<span class="dialogue-avatar dialogue-avatar-${type}"><img src="${DIALOGUE_ASSET_ROOT}/${file}" alt="${alt}" /></span>`
}

function conversationHtml() {
  return `
    <div class="dialogue-turn">
      ${avatar("user")}
      <div class="dialogue-turn-body">
        <div class="dialogue-author">锦鲤大人</div>
        <p>介绍一下 AI FDE 这个岗位，以及我转行这个岗位需要补全哪些技能？</p>
      </div>
    </div>
    <div class="dialogue-turn">
      ${avatar("ai")}
      <div class="dialogue-turn-body">
        <div class="dialogue-author">张凌赫 <span class="dialogue-ai-tag">AI</span></div>
        <p>锦鲤大人，FDE 一般指 Forward Deployed Engineer，直译是“前线部署工程师”。它介于产品、解决方案、工程、客户成功之间，核心不是坐在后方写通用功能，而是深入客户现场和业务场景，把 AI 或软件能力落到真实业务里。</p>
        <p>这个岗位通常做 4 件事：</p>
        <ol>
          <li>理解客户业务问题：拆需求、识别真实痛点、判断哪些能用 AI 或数据解决。</li>
          <li>快速搭原型和方案：用代码、脚本、工作流、API、Prompt、RAG、Agent 做验证 Demo。</li>
          <li>连接客户和研发：把现场问题翻译成产品需求、技术约束和交付方案。</li>
          <li>推动落地交付：配置、部署、验证效果、培训用户、持续迭代。</li>
        </ol>
        <p>它和你现在想转的方向有关系：你擅长复杂 B 端系统、工业语义、知识图谱、AI 中间层，把抽象技术翻译成人能用的界面。FDE 比纯产品经理更偏“能动手落地”，比纯工程师更强调“懂业务、懂用户、会沟通”。</p>
        <p><strong>你下一阶段建议补 5 块能力：</strong></p>
        <p><strong>P0：基础代码和调试能力</strong><br>至少会 Python / JS 其中一个，能看懂 API 调用、JSON、日志、报错，能用 AI 辅助改小功能、写脚本、跑 Demo。</p>
        <p><strong>P0：AI 应用落地知识</strong><br>理解 RAG、Agent、工具调用、MCP、Prompt、权限边界、评估指标和上下文管理。</p>
        <p><strong>P1：解决方案表达能力</strong><br>能把业务背景、当前痛点、方案架构、用户流程、数据连接和成功指标串成完整故事。</p>
      </div>
    </div>
    <div class="dialogue-turn">
      ${avatar("user")}
      <div class="dialogue-turn-body">
        <div class="dialogue-author">锦鲤大人</div>
        <p>转行到这个岗位最大的难点是什么？</p>
      </div>
    </div>
    <div class="dialogue-turn">
      ${avatar("ai")}
      <div class="dialogue-turn-body">
        <div class="dialogue-author">张凌赫 <span class="dialogue-ai-tag">AI</span></div>
        <p>最大的难点不是补完某一项技术，而是证明你能站在模糊、开放的客户现场，把业务问题转化成一个可运行、可验证、可交付的方案。</p>
        <ol>
          <li><strong>技术栈的广度与精度双重很压。</strong> 需要理解后端工程基础，也要有足够的 AI 应用知识密度。</li>
          <li><strong>沟通能力需要“降维打击”。</strong> 既能和业务方挖出真正痛点，也能和技术人员讨论模型和系统约束。</li>
          <li><strong>落地过程高度非标准化。</strong> 需要在数据不完整、权限复杂、需求变化的情况下持续推进。</li>
        </ol>
      </div>
    </div>
  `
}

function renderGroups(root, unlocked, selected) {
  const list = root.querySelector(".dialogue-groups")
  if (!list) return
  list.innerHTML = groups.map(group => {
    const locked = group.private && !unlocked
    const items = locked
      ? `<button class="dialogue-locked-row" data-unlock="${group.id}">
          <span>${lockIcon()}</span>
          <span>内容已锁定</span>
        </button>`
      : group.items.map(([title, progress, tags]) => `
          <button class="dialogue-topic${tags?.length ? " has-tags" : ""}${title === selected ? " is-active" : ""}" data-topic="${title}">
            <span class="dialogue-topic-main">
              <span class="dialogue-topic-title">${title}</span>
              ${tags?.length ? `<span class="dialogue-topic-tags">${tags.map(tag => `<span>${tag}</span>`).join("")}</span>` : ""}
            </span>
            ${progress ? `<span class="dialogue-progress">进度${progress}</span>` : ""}
          </button>
        `).join("")
    return `
      <section class="dialogue-group${locked ? " is-locked" : ""}">
        <div class="dialogue-group-head">
          <span class="dialogue-group-label"><img src="${DIALOGUE_ASSET_ROOT}/${group.icon}" alt="" />${group.label}</span>
          ${group.private ? `<button class="dialogue-lock-toggle" data-${locked ? "unlock" : "lock"}="${group.id}" aria-label="${locked ? "解锁" : "重新锁定"}">${lockIcon(!locked)}</button>` : ""}
        </div>
        <div class="dialogue-group-items">${items}</div>
      </section>
    `
  }).join("")
}

export function initDialoguePage() {
  const root = document.getElementById("dialogue-root")
  if (!root || root.dataset.ready === "true") return
  root.dataset.ready = "true"
  root.innerHTML = `
    <aside class="dialogue-sidebar">
      <div class="dialogue-groups"></div>
    </aside>
    <section class="dialogue-stage">
      <div class="dialogue-document">
        <div class="dialogue-document-head">
          <div class="dialogue-action-pill">
            <img src="${DIALOGUE_ASSET_ROOT}/document.svg" alt="" />
            <span>整理成知识文档</span>
          </div>
        </div>
        <div class="dialogue-scroll">${conversationHtml()}</div>
      </div>
    </section>
    <div class="privacy-dialog" id="privacy-dialog" hidden>
      <form class="privacy-card">
        <button class="privacy-close" type="button" aria-label="关闭">${icon("cancel-01", { size: 18 })}</button>
        <span class="privacy-lock-mark">${lockIcon()}</span>
        <h2>解锁私密内容</h2>
        <p>故事和情绪包含较私人的内容，输入隐私密码后才能查看。</p>
        <label for="privacy-password">隐私密码</label>
        <input id="privacy-password" type="password" autocomplete="current-password" placeholder="请输入密码" />
        <span class="privacy-error" hidden>密码不正确，请重新输入</span>
        <button class="privacy-submit" type="submit">解锁故事和情绪</button>
        <span class="privacy-hint">体验密码：1234</span>
      </form>
    </div>
  `

  let unlocked = false
  let selected = "如何通过用户数据驱动设计决策"
  const modal = root.querySelector("#privacy-dialog")
  const password = root.querySelector("#privacy-password")
  const error = root.querySelector(".privacy-error")

  const render = () => renderGroups(root, unlocked, selected)
  const openModal = () => {
    if (!modal) return
    modal.hidden = false
    if (password instanceof HTMLInputElement) {
      password.value = ""
      setTimeout(() => password.focus(), 0)
    }
    if (error instanceof HTMLElement) error.hidden = true
  }
  const closeModal = () => {
    if (modal) modal.hidden = true
  }

  render()
  root.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const unlock = target.closest("[data-unlock]")
    const lock = target.closest("[data-lock]")
    const topic = target.closest("[data-topic]")
    if (unlock) openModal()
    if (lock) {
      unlocked = false
      render()
    }
    if (topic instanceof HTMLElement && topic.dataset.topic) {
      selected = topic.dataset.topic
      render()
    }
    if (target.closest(".privacy-close") || target === modal) closeModal()
  })

  root.querySelector(".privacy-card")?.addEventListener("submit", event => {
    event.preventDefault()
    if (!(password instanceof HTMLInputElement)) return
    if (password.value === PRIVATE_PASSWORD) {
      unlocked = true
      closeModal()
      render()
      return
    }
    if (error instanceof HTMLElement) error.hidden = false
    password.select()
  })

}
