/** Pages reachable before there is a session: signing in, and accepting an invitation. */
function isPublic(path: string) {
  return path === '/login' || path.startsWith('/invite/')
}

export default defineNuxtRouteMiddleware(async (to) => {
  const session = useUserSession()
  if (!session.ready.value) await session.fetch()
  if (to.path === '/login' && session.loggedIn.value) return navigateTo('/')
  if (!isPublic(to.path) && !session.loggedIn.value) return navigateTo('/login')
})
