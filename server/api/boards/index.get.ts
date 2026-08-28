import { listBoards } from '~~/server/utils/db'
import { boardViewer } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event => ({ boards: listBoards(boardViewer(sessionActor(event).principal)) }))
