import { loadBoards } from '~/composables/useBoards'

/**
 * Guarantees the :board route parameter names a board that exists, so board pages can
 * assume it and never redirect from their own setup().
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const boards = await loadBoards()
  if (boards.some(board => board.id === to.params.board)) return
  return navigateTo(boards[0] ? `/b/${boards[0].id}` : '/', { replace: true })
})
