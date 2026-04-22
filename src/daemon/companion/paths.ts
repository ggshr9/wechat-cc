import { join } from 'node:path'

export function companionDir(stateDir: string): string {
  return join(stateDir, 'companion')
}

export function personasDir(stateDir: string): string {
  return join(companionDir(stateDir), 'personas')
}

export function profilePath(stateDir: string): string {
  return join(companionDir(stateDir), 'profile.md')
}

export function personaPath(stateDir: string, name: string): string {
  return join(personasDir(stateDir), `${name}.md`)
}

export function configPath(stateDir: string): string {
  return join(companionDir(stateDir), 'config.json')
}

export function runsPath(stateDir: string): string {
  return join(companionDir(stateDir), 'runs.jsonl')
}

export function pushLogPath(stateDir: string): string {
  return join(companionDir(stateDir), 'push-log.jsonl')
}
