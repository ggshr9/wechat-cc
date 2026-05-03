import type { Lifecycle } from '../lib/lifecycle'

export interface IlinkLifecycleDeps {
  ilink: { flush(): Promise<void> }
}

export function registerIlink(deps: IlinkLifecycleDeps): Lifecycle {
  let stopped = false
  return {
    name: 'ilink',
    stop: async () => {
      if (stopped) return
      stopped = true
      await deps.ilink.flush()
    },
  }
}
