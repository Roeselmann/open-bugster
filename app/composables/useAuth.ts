import type { UserRole } from '~~/shared/types/domain'

export function useAuth() {
  const session = useUserSession()
  const instanceAdmin = computed(() => {
    const role = session.user.value?.role as UserRole | undefined
    return role === 'owner' || role === 'admin'
  })

  async function logout() {
    await $fetch('/api/auth/logout', { method: 'POST' })
    await session.fetch()
    await navigateTo('/login')
  }

  return { user: session.user, instanceAdmin, logout }
}

/** "Ada Lovelace", falling back to the email for an account that has no name yet. */
export function displayName(person: { firstName?: string | null; lastName?: string | null; email: string }): string {
  return [person.firstName, person.lastName].filter(Boolean).join(' ').trim() || person.email
}

export function initials(person: { firstName?: string | null; lastName?: string | null; email: string }): string {
  const letters = [person.firstName?.[0], person.lastName?.[0]].filter(Boolean).join('')
  return (letters || person.email.slice(0, 2)).toUpperCase()
}
