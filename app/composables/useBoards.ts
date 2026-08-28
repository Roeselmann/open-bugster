import type { BoardSummary } from '~~/shared/types/domain'

const BOARD_COOKIE = 'open-bugster-board'
const BOARD_STATE = 'boards'

function boardState() {
  return useState<BoardSummary[]>(BOARD_STATE, () => [])
}

/**
 * Loads the board list into shared state. Route middleware calls this before a page
 * renders, so components can read the boards synchronously and never have to redirect
 * from inside setup(). The state is serialised into the SSR payload, so the client does
 * not fetch it a second time.
 */
export async function loadBoards(force = false): Promise<BoardSummary[]> {
  const state = boardState()
  if (state.value.length && !force) return state.value
  const { boards } = await useRequestFetch()<{ boards: BoardSummary[] }>('/api/boards')
  state.value = boards
  return boards
}

export function useBoards() {
  return { boards: boardState(), refresh: () => loadBoards(true) }
}

/** Remembered across visits so "/" can reopen the board the user last worked on. */
export function useLastBoardId() {
  return useCookie<string | null>(BOARD_COOKIE, {
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
    default: () => null,
  })
}

/**
 * The board named by the current `:board` route parameter. Route middleware has already
 * loaded the list and guaranteed the parameter names a real board, so this only ever
 * returns null while a page renders outside a board route.
 */
export function useCurrentBoard() {
  const route = useRoute()
  const boards = boardState()
  const boardId = computed(() => String(route.params.board || ''))
  return {
    boardId,
    board: computed(() => boards.value.find(item => item.id === boardId.value) || null),
  }
}
