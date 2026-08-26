import { latestSyncRun } from '~~/server/utils/db'

export default defineEventHandler(() => ({ run: latestSyncRun() }))
