// @ts-check
/// <reference lib="dom" />

// Settings drawer — slides in from the right; contains 后台服务 +
// 行为 sections. Toggles in here previously lived in the wizard
// step 4. CSS uses .is-open (not the [hidden] attribute) because
// the global [hidden] { display: none !important } would defeat
// the transition.

let listenersAttached = false

export function openSettingsDrawer() {
  const drawer = document.getElementById("settings-drawer")
  if (!drawer) return
  drawer.classList.add("is-open")
}

export function closeSettingsDrawer() {
  const drawer = document.getElementById("settings-drawer")
  if (!drawer) return
  drawer.classList.remove("is-open")
}

/**
 * Attach drawer event handlers. Safe to call multiple times — only
 * the first call wires.
 *
 * @param {{ onToggleChange: (id: string, on: boolean) => void }} opts
 */
export function wireSettingsDrawer(opts) {
  if (listenersAttached) return
  listenersAttached = true

  document.getElementById("settings-close")?.addEventListener("click", closeSettingsDrawer)

  // ESC closes drawer when open.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return
    const drawer = document.getElementById("settings-drawer")
    if (drawer && drawer.classList.contains("is-open")) closeSettingsDrawer()
  })

  // Outside-click closes drawer. The check excludes #settings-open
  // (otherwise opening the drawer immediately closes it).
  document.addEventListener("click", (e) => {
    const drawer = document.getElementById("settings-drawer")
    if (!drawer || !drawer.classList.contains("is-open")) return
    const target = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target : null)
    if (!target) return
    if (drawer.contains(target)) return
    if (target.closest("#settings-open")) return
    closeSettingsDrawer()
  })

  // Toggle clicks inside the drawer — flip aria-pressed + .on, then
  // notify caller for persistence side effects.
  document.querySelectorAll("#settings-drawer [data-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      const pressed = el.getAttribute("aria-pressed") === "true"
      const next = !pressed
      el.setAttribute("aria-pressed", String(next))
      el.classList.toggle("on", next)
      opts.onToggleChange(el.id, next)
    })
  })
}
