import type { IntegrationProvider, TicketSource } from '../types/domain'

/** How each import source is named to a person. */
export const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  testflight: 'TestFlight',
  jira: 'Jira'
}

/** Which connection a ticket came through; null for one somebody wrote here. */
export function providerOfSource(source: TicketSource): IntegrationProvider | null {
  if (source === 'manual') return null
  return source === 'jira_issue' ? 'jira' : 'testflight'
}

/** The label a card or list shows next to an imported ticket; null for a manual one. */
export function sourceLabel(source: TicketSource): string | null {
  const provider = providerOfSource(source)
  return provider ? PROVIDER_LABELS[provider] : null
}

/** Reads an activity payload's provider, defaulting to TestFlight for entries written before there was a choice. */
export function providerLabel(provider: string | null | undefined): string {
  return provider && provider in PROVIDER_LABELS ? PROVIDER_LABELS[provider as IntegrationProvider] : PROVIDER_LABELS.testflight
}
