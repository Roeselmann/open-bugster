import type { InjectionKey, Ref } from 'vue'
import type { TicketType } from '~~/shared/types/domain'

/**
 * The workspace's full ticket types, provided by a page that lists tickets. Tickets carry
 * only a slim reference to their type — no image bytes — so a badge deep in the card tree
 * reaches the uploaded picture through this rather than through a chain of props.
 */
export const TICKET_TYPES_KEY: InjectionKey<Ref<TicketType[]>> = Symbol('ticketTypes')
