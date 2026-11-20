import { boardToday } from '../../shared/utils/due-date'
import { findLane, findTicket, sweepLiveWindows, type LiveSignal } from './db'
import { clockEvents, dispatch } from './webhook'

/**
 * One pass of the clock over every live window: writes what has happened since the last pass
 * into the tickets' histories (and so into `whats_new`), then tells the boards' webhooks.
 *
 * The history is written first and is what makes a signal happen once — the webhook is a
 * consequence of it, fire and forget like every other event, so a dead receiver cannot make
 * the next pass announce the same go-live again.
 */
export function runLiveSweep(today = boardToday()): LiveSignal[] {
  const signals = sweepLiveWindows(today)
  for (const signal of signals) {
    try {
      const ticket = findTicket(signal.ticketId)
      if (!ticket) continue
      const lane = findLane(ticket.laneId)
      dispatch(signal.boardId, clockEvents[signal.kind], {
        actor: { principalId: null, agentId: null, channel: 'system' },
        data: {
          ticket,
          lane: lane ? { id: lane.id, name: lane.name, isLive: lane.isLive } : null,
          date: signal.date
        }
      })
    } catch (error) {
      console.warn(`[open-bugster] could not announce ${signal.kind} for ${signal.ticketId}:`, (error as Error).message)
    }
  }
  return signals
}

/** How often the clock looks, in minutes. `LIVE_SWEEP_MINUTES=0` switches it off. */
export function liveSweepMinutes(): number {
  const configured = Number(process.env.LIVE_SWEEP_MINUTES)
  return Number.isFinite(configured) && configured >= 0 ? configured : 15
}
