import type { DueTicket } from '~~/shared/types/domain'

/**
 * The tickets across all of the viewer's boards whose due date has lit their card, for the
 * header's alarm. One shared fetch: the board page refreshes it when a due date changes.
 */
export function useDueTickets() {
  const { data, refresh } = useFetch<{ tickets: DueTicket[] }>('/api/tickets/due', {
    key: 'due-tickets',
    default: () => ({ tickets: [] }),
  })
  const tickets = computed(() => data.value?.tickets || [])
  return { tickets, refresh }
}

/** Asks the header's alarm to look again, from a page that changed a ticket. */
export function refreshDueTickets() {
  return refreshNuxtData('due-tickets')
}
