import { loadBoards } from '~/composables/useBoards'
import { loadWorkspaces, useLastWorkspaceId } from '~/composables/useWorkspaces'

/**
 * Guarantees the :board route parameter names a board that exists, so board pages can
 * assume it and never redirect from their own setup().
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const [boards] = await Promise.all([loadBoards(), loadWorkspaces()])
  const board = boards.find(item => item.id === to.params.board)
  if (!board) {
    // A dead link falls back within the workspace the user is in, not to just any board.
    const lastWorkspaceId = useLastWorkspaceId()
    const fallback = boards.find(item => item.workspaceId === lastWorkspaceId.value) || boards[0]
    return navigateTo(fallback ? `/b/${fallback.id}` : '/', { replace: true })
  }
  // The archive is for the board's administrators, and so is the list it opens with — the
  // page has to be turned away here rather than left to fail on its own first request.
  if (to.path.endsWith('/archive') && board.role !== 'admin') return navigateTo(`/b/${board.id}`, { replace: true })
  if (to.path.includes('/settings')) {
    // Of the settings sections only the member roster is offered to everyone else.
    if (board.role !== 'admin' && !to.path.endsWith('/settings/users')) {
      return navigateTo(`/b/${board.id}/settings/users`, { replace: true })
    }
    // The bare /settings path resolves to the shell with an empty outlet, so it picks a section.
    if (to.path.endsWith('/settings')) return navigateTo(`/b/${board.id}/settings/board`, { replace: true })
  }
})
