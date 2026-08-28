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
  }
}

export {}
