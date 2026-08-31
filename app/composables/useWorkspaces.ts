import type { WorkspaceSummary } from '~~/shared/types/domain'

const WORKSPACE_COOKIE = 'open-bugster-workspace'
const WORKSPACE_STATE = 'workspaces'
const WORKSPACE_STATE_OWNER = 'workspaces-loaded-for'

function workspaceState() {
  return useState<WorkspaceSummary[]>(WORKSPACE_STATE, () => [])
}

/** Whose list the cache holds. Null before anything has been loaded. */
function workspacesLoadedFor() {
  return useState<string | null>(WORKSPACE_STATE_OWNER, () => null)
}

/** Same contract as `loadBoards`: cached per account, serialised into the SSR payload. */
export async function loadWorkspaces(force = false): Promise<WorkspaceSummary[]> {
  const state = workspaceState()
  const owner = workspacesLoadedFor()
  const userId = useUserSession().user.value?.id ?? null
  if (state.value.length && !force && owner.value === userId) return state.value
  const { workspaces } = await useRequestFetch()<{ workspaces: WorkspaceSummary[] }>('/api/workspaces')
  state.value = workspaces
  owner.value = userId
  return workspaces
}

/** Drops the cached list, so nothing of one session is left in memory for the next. */
export function clearWorkspaces() {
  workspaceState().value = []
  workspacesLoadedFor().value = null
}

export function useWorkspaces() {
  return { workspaces: workspaceState(), refresh: () => loadWorkspaces(true) }
}

/** Remembered across visits, so "/" can reopen a board in the workspace last worked in. */
export function useLastWorkspaceId() {
  return useCookie<string | null>(WORKSPACE_COOKIE, {
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
    default: () => null,
  })
}

/**
 * The workspace the user is in right now. On a board page that is the board's workspace,
 * whatever any cookie says — the two must never disagree on screen. Everywhere else it is
 * the remembered one, falling back to the first the user can see.
 */
export function useCurrentWorkspace() {
  const workspaces = workspaceState()
  const { board } = useCurrentBoard()
  const lastWorkspaceId = useLastWorkspaceId()
  const workspace = computed(() => {
    const boardWorkspace = board.value ? workspaces.value.find(item => item.id === board.value?.workspaceId) : null
    return boardWorkspace
      || workspaces.value.find(item => item.id === lastWorkspaceId.value)
      || workspaces.value[0]
      || null
  })
  return { workspace, workspaceId: computed(() => workspace.value?.id || '') }
}
