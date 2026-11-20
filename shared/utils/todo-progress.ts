/**
 * The traffic light a ticket shows for its to-do list, subtickets included: green once
 * everything is done, orange from half done, red below that. Null for a ticket without any.
 */
export type TodoLight = 'green' | 'orange' | 'red'

export const TODO_LIGHT_LABELS: Record<TodoLight, string> = {
  green: 'All to-dos done',
  orange: 'At least half of the to-dos done',
  red: 'Less than half of the to-dos done',
}

export function todoLight(todos: ReadonlyArray<{ completed: boolean }>): TodoLight | null {
  if (!todos.length) return null
  const done = todos.filter(todo => todo.completed).length
  if (done === todos.length) return 'green'
  return done * 2 >= todos.length ? 'orange' : 'red'
}

/** What a decision landed on, as one line: the picked options in order, then the typed answer. */
export function decisionAnswer(decision: { options: string[]; chosen: number[]; other: string | null }): string {
  return [...decision.chosen.map(index => decision.options[index]).filter(Boolean), ...(decision.other ? [decision.other] : [])].join(', ')
}
