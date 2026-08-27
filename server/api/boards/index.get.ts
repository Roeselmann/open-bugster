import { listBoards } from '~~/server/utils/db'

export default defineEventHandler(() => ({ boards: listBoards() }))
