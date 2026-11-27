import { findLane, findTicket, sweepLiveWindows, sweepRounds, type LiveSignal, type RoundSignal } from './db'
import { clockEvents, dispatch } from './webhook'

/**
 * One pass of the clock over every live window: writes what has happened since the last pass
 * into the tickets' histories (and so into `whats_new`), then tells the boards' webhooks.
 *
 * The history is written first and is what makes a signal happen once — the webhook is a
 * consequence of it, fire and forget like every other event, so a dead receiver cannot make
 * the next pass announce the same go-live again.
 */
export function runLiveSweep(today?: string): LiveSignal[] {
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

/**
 * One pass of the clock over every recurring ticket: closes the rounds whose time is up and
 * starts the next ones (see `sweepRounds`), then tells the boards' webhooks — `ticket.round_missed`
 * for a round that went by unfinished, `ticket.new_round` for one that was done. As with the
 * live windows, the round row written first is what makes this happen once.
 */
export function runRoundSweep(today?: string): RoundSignal[] {
  const signals = sweepRounds(today)
  for (const signal of signals) {
    try {
      const ticket = findTicket(signal.ticketId)
      if (!ticket) continue
      dispatch(signal.boardId, clockEvents[signal.kind], {
        actor: { principalId: null, agentId: null, channel: 'system' },
        data: { ticket, round: { date: signal.date, outcome: signal.outcome, next: signal.next } }
      })
    } catch (error) {
      console.warn(`[open-bugster] could not announce ${signal.kind} for ${signal.ticketId}:`, (error as Error).message)
    }
  }
  return signals
}
