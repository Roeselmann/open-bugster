import { liveSweepMinutes, runLiveSweep, runRoundSweep } from '~~/server/utils/live-windows'

/**
 * Lets the calendar speak: a live window opening, nearing its end or running out happens
 * without anybody touching the ticket, so no request would ever announce it — and neither
 * would the next round of a recurring ticket coming, which closes the last one.
 *
 * Runs once at startup and then every `LIVE_SWEEP_MINUTES` (15 by default). Dates are whole
 * days, so the interval only decides how soon after midnight a day's signals go out; each one
 * goes out once however often this runs. The timer is unref'd so it never keeps a process
 * alive that is otherwise shutting down.
 */
export default defineNitroPlugin(() => {
  const minutes = liveSweepMinutes()
  if (minutes <= 0) return

  const sweep = () => {
    try {
      const signals = runLiveSweep()
      if (signals.length) console.info(`[open-bugster] live windows: ${signals.length} new signal(s).`)
    } catch (error) {
      console.warn('[open-bugster] live window sweep failed:', (error as Error).message)
    }
    try {
      const rounds = runRoundSweep()
      if (rounds.length) console.info(`[open-bugster] recurring tickets: ${rounds.length} round(s) closed.`)
    } catch (error) {
      console.warn('[open-bugster] round sweep failed:', (error as Error).message)
    }
  }
  sweep()
  setInterval(sweep, minutes * 60_000).unref?.()
})
