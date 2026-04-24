import { join } from 'node:path'

export function companionDir(stateDir: string): string {
  return join(stateDir, 'companion')
}

export function configPath(stateDir: string): string {
  return join(companionDir(stateDir), 'config.json')
}
