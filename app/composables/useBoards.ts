import type { BoardSummary } from '~~/shared/types/domain'

const BOARD_COOKIE = 'open-bugster-board'
const BOARD_STATE = 'boards'
const BOARD_STATE_OWNER = 'boards-loaded-for'

function boardState() {
  return useState<BoardSummary[]>(BOARD_STATE, () => [])
}

/** Whose list the cache holds. Null before anything has been loaded. */
function loadedFor() {
  return useState<string | null>(BOARD_STATE_OWNER, () => null)
}

/**
 * Loads the board list into shared state. Route middleware calls this before a page
 * renders, so components can read the boards synchronously and never have to redirect
 * from inside setup(). The state is serialised into the SSR payload, so the client does
 * not fetch it a second time.
 */
export async function loadBoards(force = false): Promise<BoardSummary[]> {
  const state = boardState()
  const owner = loadedFor()
  const userId = useUserSession().user.value?.id ?? null
  // The cache belongs to the account that fetched it. Signing in as somebody else happens
  // without a page load, so without this the next account inherits the previous one's boards,
  // their roles and their member counts until the tab is reloaded.
  if (state.value.length && !force && owner.value === userId) return state.value
  const { boards } = await useRequestFetch()<{ boards: BoardSummary[] }>('/api/boards')
  state.value = boards
  owner.value = userId
  return boards
}

/** Drops the cached list, so nothing of one session is left in memory for the next. */
export function clearBoards() {
  boardState().value = []
  loadedFor().value = null
}

/**
 * Whether this person may work any board through a token — the API, or an agent over MCP.
 *
 * An instance administrator always may. For everybody else it takes a membership carrying the
 * permission, which a board administrator's always does. Somebody with none of that has
 * nothing to configure under Integrations, so the tab is not shown to them at all.
 */
export function useCanAutomate() {
  const { user, instanceAdmin } = useAuth()
  const boards = boardState()
  return computed(() => instanceAdmin.value || boards.value.some(board =>
    board.members.some(member => member.userId === user.value?.id && member.mayAutomate)))
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
