import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface HearthIngestInput {
  channel: string
  message_id: string
  from: string
  text: string
  received_at: string
}

export interface HearthIngestResult {
  ok: boolean
  summary: string
  change_id?: string
  error?: string
}

export interface HearthApi {
  ingestFromChannel(input: HearthIngestInput, opts: {
    vaultRoot: string
    agent: 'mock' | 'claude'
    hearthStateDir: string
  }): Promise<HearthIngestResult>
  listPending(opts: { hearthStateDir: string; limit: number }): { rendered: string; items: unknown[] }
  showPending(changeId: string, opts: { hearthStateDir: string }): { ok: boolean; rendered: string }
  applyForOwner(changeId: string, opts: {
    vaultRoot: string
    hearthStateDir: string
    ownerId: string
    channel: string
  }): Promise<{ ok: boolean; rendered: string }>
  renderPlanMarkdown(changeId: string, opts: { hearthStateDir: string }): { ok: boolean; title?: string; markdown: string }
}

export type HearthLoadResult =
  | { ok: true; api: HearthApi; source: string }
  | { ok: false; reason: 'not_found' | 'invalid_export'; checked: string[]; error?: string }

export type HearthImporter = (specifier: string) => Promise<unknown>

const REQUIRED_EXPORTS = [
  'ingestFromChannel',
  'listPending',
  'showPending',
  'applyForOwner',
  'renderPlanMarkdown',
] as const

const defaultImporter: HearthImporter = (specifier) => import(specifier)

export async function loadHearthApi(opts: {
  env?: NodeJS.ProcessEnv
  cwd?: string
  homeDir?: string
  importer?: HearthImporter
} = {}): Promise<HearthLoadResult> {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const homeDir = opts.homeDir ?? homedir()
  const importer = opts.importer ?? defaultImporter
  const candidates = hearthCandidates({ env, cwd, homeDir })
  const checked: string[] = []
  let invalidExportError: string | undefined
  let importError: string | undefined

  for (const candidate of candidates) {
    checked.push(candidate.label)
    try {
      const mod = await importer(candidate.specifier)
      const api = asHearthApi(mod)
      if (api) return { ok: true, api, source: candidate.label }
      invalidExportError = `${candidate.label} did not export ${REQUIRED_EXPORTS.join(', ')}`
    } catch (err) {
      importError = err instanceof Error ? err.message : String(err)
    }
  }

  return invalidExportError
    ? { ok: false, reason: 'invalid_export', checked, error: invalidExportError }
    : { ok: false, reason: 'not_found', checked, error: importError }
}

function hearthCandidates(opts: {
  env: NodeJS.ProcessEnv
  cwd: string
  homeDir: string
}): { label: string; specifier: string }[] {
  const out: { label: string; specifier: string }[] = []
  const seen = new Set<string>()

  function add(label: string, specifier: string): void {
    if (seen.has(specifier)) return
    seen.add(specifier)
    out.push({ label, specifier })
  }

  function addPath(label: string, path: string): void {
    const abs = resolve(path)
    if (!existsSync(abs)) return
    const st = statSync(abs)
    if (st.isDirectory()) {
      for (const entry of [
        join(abs, 'src', 'index.ts'),
        join(abs, 'index.ts'),
        join(abs, 'dist', 'index.js'),
      ]) {
        if (existsSync(entry)) add(`${label}:${entry}`, pathToFileURL(entry).href)
      }
      return
    }
    if (st.isFile()) add(`${label}:${abs}`, pathToFileURL(abs).href)
  }

  if (opts.env.HEARTH_MODULE) {
    const spec = opts.env.HEARTH_MODULE
    if (looksLikePath(spec)) addPath('HEARTH_MODULE', spec)
    else add('HEARTH_MODULE', spec)
  }
  if (opts.env.HEARTH_HOME) addPath('HEARTH_HOME', opts.env.HEARTH_HOME)

  addPath('../hearth', join(dirname(opts.cwd), 'hearth'))
  addPath('~/Documents/hearth', join(opts.homeDir, 'Documents', 'hearth'))
  add('node_modules:hearth', 'hearth')

  return out
}

function looksLikePath(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('~')
}

function asHearthApi(mod: unknown): HearthApi | null {
  if (!mod || typeof mod !== 'object') return null
  for (const name of REQUIRED_EXPORTS) {
    if (typeof (mod as Record<string, unknown>)[name] !== 'function') return null
  }
  return mod as HearthApi
}
