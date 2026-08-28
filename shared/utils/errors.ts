/** Unwraps the `statusMessage` every API route throws with, whichever layer surfaced it. */
export function errorText(error: unknown): string {
  const candidate = error as { data?: { statusMessage?: string }; statusMessage?: string } | null
  return candidate?.data?.statusMessage || candidate?.statusMessage || 'Something went wrong.'
}
