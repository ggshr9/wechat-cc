import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Why this test exists:
//
// On Windows, when a binary built with PE subsystem 2 (GUI/hidden — what
// `wechat-cc-cli.exe` becomes after the desktop.yml PE-flip post-process
// from v0.5.3) calls `child_process.spawnSync` to run a console-subsystem
// child (powershell.exe, where.exe, tasklist.exe, git.exe, ffmpeg.exe,
// bun.exe, ...), Windows allocates a fresh console window for that child
// because the parent has none to inherit. Result: the dashboard's 5-second
// doctor poll flashes 5+ console windows every tick — looks like a virus.
//
// Setting `windowsHide: true` in the spawnSync options sets
// STARTF_USESHOWWINDOW + SW_HIDE so the allocated console stays invisible.
//
// This test is a hard lint that every spawnSync call in production source
// (src/**/*.ts excluding *.test.ts) declares `windowsHide` literally in
// its options bag. Catches the next time someone adds a spawn site and
// forgets the flag — without this we'd ship another v0.5.3-class
// regression. Verified 2026-05-05.

const REPO_ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/lib/ → repo root
  return join(here, '..', '..')
})()

function* walkTsFiles(dir: string): Generator<string> {
  for (const ent of readdirSync(dir)) {
    if (ent === 'node_modules' || ent === '.git' || ent === 'dist' || ent === 'target') continue
    const p = join(dir, ent)
    const s = statSync(p)
    if (s.isDirectory()) {
      yield* walkTsFiles(p)
      continue
    }
    if (!p.endsWith('.ts')) continue
    if (p.endsWith('.test.ts')) continue
    if (p.endsWith('.d.ts')) continue
    yield p
  }
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

describe('spawnSync windowsHide:true lint (subsystem=2 daemon prerequisite)', () => {
  it('every production spawnSync sets windowsHide in its options', () => {
    const violations: string[] = []
    const srcRoot = join(REPO_ROOT, 'src')
    for (const file of walkTsFiles(srcRoot)) {
      const text = readFileSync(file, 'utf8')
      // Find each `spawnSync(` call. The options bag may span up to ~400
      // chars of arguments + multiline options object; 600 is generous.
      const re = /spawnSync\s*\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const tail = text.slice(m.index, m.index + 600)
        // Crude but accurate enough: every legitimate options bag in this
        // codebase puts `windowsHide` literally in the object literal.
        if (!tail.includes('windowsHide')) {
          violations.push(`${relative(REPO_ROOT, file)}:${lineNumberAt(text, m.index)}`)
        }
      }
    }
    expect(violations, `${violations.length} spawnSync site(s) missing windowsHide:\n  ${violations.join('\n  ')}`).toEqual([])
  })

  // Sanity: the lint scanner actually finds spawnSync sites. Without this,
  // a refactor that moves all spawn calls into a missed directory would
  // pass the test for the wrong reason.
  it('lint scanner finds the known spawnSync sites (regression guard for the guard)', () => {
    let total = 0
    for (const file of walkTsFiles(join(REPO_ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8')
      const matches = text.match(/spawnSync\s*\(/g)
      if (matches) total += matches.length
    }
    // As of v0.5.4: 3 in service-manager.ts + 1 in util.ts + 2 in
    // daemon-kill.ts + 1 in single-instance.ts + 1 in media.ts +
    // 2 in update.ts + 1 in powershell-validator.ts = 11. Allow growth.
    expect(total).toBeGreaterThanOrEqual(11)
  })
})
