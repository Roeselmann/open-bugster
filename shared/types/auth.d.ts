import type { UserRole } from './domain'

declare module '#auth-utils' {
  interface User {
    id: string
    email: string
    firstName: string
    lastName: string
    role: UserRole
    /** Bumped whenever an account is disabled or its password changes, to retire live sessions. */
    sessionVersion: number
    /** Added on every session fetch rather than kept in the cookie, so a new portrait shows at once. */
    avatarUrl?: string | null
  }
}

export {}
