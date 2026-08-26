export default defineNuxtRouteMiddleware(async (to) => {
  const session = useUserSession()
  if (!session.ready.value) await session.fetch()
  if (to.path === '/login' && session.loggedIn.value) return navigateTo('/')
  if (to.path !== '/login' && !session.loggedIn.value) return navigateTo('/login')
})
