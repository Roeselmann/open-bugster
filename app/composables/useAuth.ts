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
    // Signing out leaves nothing of this account behind for whoever signs in next.
    clearBoards()
    clearWorkspaces()
    await navigateTo('/login')
  }

  return { user: session.user, instanceAdmin, logout }
}

/** Anything person-shaped enough to put a name on screen. */
type Nameable = { firstName?: string | null; lastName?: string | null; email?: string | null; anonymizedAt?: string | null }

/**
 * "Ada Lovelace", falling back to the address for somebody who has no name yet — and to a
 * fixed label for an erased account, which by design has neither.
 */
export function displayName(person: Nameable): string {
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ').trim()
  if (name) return name
  if (person.email) return person.email
  return person.anonymizedAt ? 'Deleted user' : 'Unknown'
}

export function initials(person: Nameable): string {
  const letters = [person.firstName?.[0], person.lastName?.[0]].filter(Boolean).join('')
  return (letters || person.email?.slice(0, 2) || '?').toUpperCase()
}
