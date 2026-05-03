import type { Db } from '../lib/db'
import type { IlinkAdapter } from './ilink-glue'

export interface StartupSweepDeps {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  log: (tag: string, line: string) => void
  runIntrospectOnce: () => Promise<void>
}

/** Stub — full impl in P-Task 19. */
export function runStartupSweeps(_deps: StartupSweepDeps): void {
  /* no-op until P-Task 19 lands */
}
