import { describe, expect, it } from 'vitest'
import { todoLight } from '../shared/utils/todo-progress'

const list = (done: number, open: number) => [
  ...Array.from({ length: done }, () => ({ completed: true })),
  ...Array.from({ length: open }, () => ({ completed: false })),
]

describe('todoLight', () => {
  it('stays dark without to-dos', () => {
    expect(todoLight([])).toBeNull()
  })

  it('is green only once everything is done', () => {
    expect(todoLight(list(3, 0))).toBe('green')
    expect(todoLight(list(1, 0))).toBe('green')
  })

  it('is orange from exactly half done up to one short of all', () => {
    expect(todoLight(list(1, 1))).toBe('orange')
    expect(todoLight(list(2, 2))).toBe('orange')
    expect(todoLight(list(3, 1))).toBe('orange')
  })

  it('is red below half', () => {
    expect(todoLight(list(0, 1))).toBe('red')
    expect(todoLight(list(1, 2))).toBe('red')
    expect(todoLight(list(2, 5))).toBe('red')
  })
})
