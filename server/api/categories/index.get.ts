import { listCategories } from '~~/server/utils/db'

export default defineEventHandler(() => ({ categories: listCategories() }))
