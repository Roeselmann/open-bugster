import { loadBoards } from '~/composables/useBoards'

/**
 * Guarantees the :board route parameter names a board that exists, so board pages can
 * assume it and never redirect from their own setup().
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const boards = await loadBoards()
  const board = boards.find(item => item.id === to.params.board)
  if (!board) return navigateTo(boards[0] ? `/b/${boards[0].id}` : '/', { replace: true })
  // The archive is for the board's administrators, and so is the list it opens with — the
  // page has to be turned away here rather than left to fail on its own first request.
  if (to.path.endsWith('/archive') && board.role !== 'admin') return navigateTo(`/b/${board.id}`, { replace: true })
})
