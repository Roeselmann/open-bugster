import { loadBoards, useLastBoardId } from '~/composables/useBoards'

/** Sends "/" to the board the user last worked on, falling back to the first one. */
export default defineNuxtRouteMiddleware(async () => {
  const boards = await loadBoards()
  const lastBoardId = useLastBoardId()
  const target = boards.find(board => board.id === lastBoardId.value) || boards[0]
  if (target) return navigateTo(`/b/${target.id}`, { replace: true })
})
