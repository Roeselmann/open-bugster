/**
 * The ticket numbers a search asks for when it is a list of them: "12, 15", "#12 #15" or
 * "12,15 #20". Null for anything else — a single number included, which stays an ordinary
 * text search so that "12" keeps finding #120 and a build 12 as it always has.
 */
export function ticketNumberList(query: string): number[] | null {
  const parts = query.split(/[\s,;]+/).filter(Boolean)
  if (parts.length < 2 || !parts.every(part => /^#?\d+$/.test(part))) return null
  return parts.map(part => Number(part.replace('#', '')))
}
