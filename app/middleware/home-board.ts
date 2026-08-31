import { loadBoards, useLastBoardId } from '~/composables/useBoards'
import { loadWorkspaces, useLastWorkspaceId } from '~/composables/useWorkspaces'

/**
 * Sends "/" to the board the user last worked on, inside the workspace they are in.
 *
 * The workspace narrows before the board decides: the remembered board only wins if it
 * belongs to the current workspace, otherwise that workspace's first board does. A workspace
 * with no boards resolves to nothing, and "/" stays to show its empty state.
 */
export default defineNuxtRouteMiddleware(async () => {
  const [boards, workspaces] = await Promise.all([loadBoards(), loadWorkspaces()])
  const lastBoardId = useLastBoardId()
  const lastWorkspaceId = useLastWorkspaceId()
  const workspace = workspaces.find(item => item.id === lastWorkspaceId.value) || workspaces[0]
  const inWorkspace = workspace ? boards.filter(board => board.workspaceId === workspace.id) : boards
  const target = inWorkspace.find(board => board.id === lastBoardId.value)
    || inWorkspace[0]
    // A stale cookie must not strand somebody on an empty page while their boards live on.
    || (workspace && !workspace.boardCount ? undefined : boards[0])
  if (target) return navigateTo(`/b/${target.id}`, { replace: true })
})
