import { describe, expect, it } from 'vitest'
import { satisfiesRole } from '../server/utils/access'
import { boardRoles } from '../shared/types/domain'

describe('board role ranking', () => {
  it('lets every role cover itself', () => {
    for (const role of boardRoles) expect(satisfiesRole(role, role)).toBe(true)
  })

  it('ranks admin above editor above viewer', () => {
    expect(satisfiesRole('admin', 'editor')).toBe(true)
    expect(satisfiesRole('admin', 'viewer')).toBe(true)
    expect(satisfiesRole('editor', 'viewer')).toBe(true)
  })

  it('refuses to promote a lower role', () => {
    expect(satisfiesRole('viewer', 'editor')).toBe(false)
    expect(satisfiesRole('viewer', 'admin')).toBe(false)
    expect(satisfiesRole('editor', 'admin')).toBe(false)
  })
})
