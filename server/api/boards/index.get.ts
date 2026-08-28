import { listBoards } from '~~/server/utils/db'
import { boardViewer, requireAuthUser } from '~~/server/utils/access'

export default defineEventHandler(event => ({ boards: listBoards(boardViewer(requireAuthUser(event))) }))
