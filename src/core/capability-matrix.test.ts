import { describe, it, expect } from 'vitest'
import {
  CAPABILITY_MATRIX,
  lookup,
  assertSupported,
  UnsupportedCombinationError,
  type MatrixRow,
  type PermissionMode,
} from './capability-matrix'
import type { Mode, ProviderId } from './conversation'

describe('CAPABILITY_MATRIX', () => {
  it('contains exactly 16 rows (4 modes × 2 providers × 2 perms)', () => {
    expect(CAPABILITY_MATRIX).toHaveLength(16)
  })

  it.each(CAPABILITY_MATRIX)(
    'row $mode/$provider/$permissionMode round-trips through lookup',
    (row: MatrixRow) => {
      expect(lookup(row.mode, row.provider, row.permissionMode)).toBe(row)
    },
  )

  it.each(CAPABILITY_MATRIX)(
    'row $mode/$provider/$permissionMode satisfies invariants',
    (row: MatrixRow) => {
      if (row.provider === 'claude') expect(row.approvalPolicy).toBeNull()
      if (row.provider === 'codex')  expect(row.approvalPolicy).not.toBeNull()
      if (row.permissionMode === 'dangerously') expect(row.askUser).toBe('never')
      if (row.mode === 'primary_tool') expect(row.delegate).toBe('loaded')
      else                              expect(row.delegate).toBe('unloaded')
      if (row.mode === 'parallel' || row.mode === 'chatroom') expect(row.replyPrefix).toBe('always')
      if (row.mode === 'solo') expect(row.replyPrefix).toBe('never')
      if (row.mode === 'primary_tool') expect(row.replyPrefix).toBe('on-fallback-only')
    },
  )

  it('every row currently has forbidden=false (v1.0)', () => {
    for (const row of CAPABILITY_MATRIX) expect(row.forbidden).toBe(false)
  })
})

describe('lookup', () => {
  it('throws on unknown combo', () => {
    expect(() => lookup('solo' as Mode['kind'], 'mystery' as ProviderId, 'strict' as PermissionMode))
      .toThrow(/no row for/)
  })
})

describe('assertSupported', () => {
  it('passes when combo is supported (forbidden=false)', () => {
    expect(() => assertSupported('solo', 'claude', 'strict')).not.toThrow()
  })

  it('throws UnsupportedCombinationError when forbidden', () => {
    // simulate by mutating a row's forbidden flag for one assertion only
    const row = CAPABILITY_MATRIX[0]!
    const original = row.forbidden
    ;(row as { forbidden: boolean }).forbidden = true
    try {
      expect(() => assertSupported(row.mode, row.provider, row.permissionMode))
        .toThrow(UnsupportedCombinationError)
    } finally {
      ;(row as { forbidden: boolean }).forbidden = original
    }
  })
})
