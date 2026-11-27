const withWeekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const withoutWeekday = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** A YYYY-MM-DD day written out for a date field: "Fri 27 Nov 2026", or "27 Nov 2026" where room is short. */
export function writtenDay(date: string, options: { weekday?: boolean } = {}): string {
  const time = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(time)) return date
  return (options.weekday === false ? withoutWeekday : withWeekday).format(new Date(time)).replace(',', '')
}
