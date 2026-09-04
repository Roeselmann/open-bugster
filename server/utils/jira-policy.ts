import type { TicketPriority } from '../../shared/types/domain'
import { adfToMarkdown } from './adf'

/**
 * The rules of the Jira import that need no network: what a site address may look like, which
 * JQL a sync sends, how Jira's priorities and text land on a ticket. Kept apart from the client
 * in `jira.ts` so they can be tested without a Jira.
 */

/** Adds the scheme a pasted host lacks and reduces a deep link to the site it belongs to. */
export function normalizeSiteUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withScheme).origin
  } catch {
    return trimmed
  }
}

/** A Jira Cloud site: https, a host, and nothing else. Plain http only for a stand-in on this machine. */
export function isJiraSiteUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    return (url.protocol === 'https:' || (url.protocol === 'http:' && local)) && Boolean(url.hostname) && url.origin === value
  } catch {
    return false
  }
}

/** `YYYY-MM-DD HH:mm` in UTC, for the comment timestamps folded into a description. */
export function formatJqlDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

/** Jira's default priority scheme onto the board's four levels; anything custom lands in the middle. */
export function jiraPriorityToBugster(name: string | null | undefined): TicketPriority {
  switch ((name || '').trim().toLowerCase()) {
    case 'highest':
    case 'blocker':
    case 'critical':
      return 'urgent'
    case 'high':
    case 'major':
      return 'high'
    case 'low':
    case 'lowest':
    case 'minor':
    case 'trivial':
      return 'low'
    default:
      return 'medium'
  }
}

export function titleFromIssue(key: string, summary: string | null | undefined): string {
  const normalized = summary?.replace(/\s+/g, ' ').trim()
  return normalized || key
}

export function issueUrl(siteUrl: string, key: string): string {
  return `${normalizeSiteUrl(siteUrl)}/browse/${encodeURIComponent(key)}`
}

/** What the settings page shows in place of a stored token: enough to recognise it, never to use it. */
export function tokenLabel(token: string): string {
  const tail = token.trim().slice(-4)
  return `Token · …${tail}`
}

export interface JiraCommentInput {
  author: string | null
  created: string | null
  /** The comment body, ADF from the v3 API or plain text. */
  body: unknown
}

/**
 * The description an imported issue arrives with: its own text as Markdown, followed by the
 * comments Jira held. The import is a snapshot, so they travel with the ticket rather than
 * becoming comments here that nobody present wrote.
 */
export function describeIssue(description: unknown, comments: JiraCommentInput[]): string {
  const body = adfToMarkdown(description).trim()
  const notes = comments
    .map(comment => {
      const text = adfToMarkdown(comment.body).trim()
      if (!text) return ''
      const when = comment.created ? formatCommentDate(comment.created) : ''
      const heading = [comment.author ? `**${comment.author}**` : '**Unknown**', when].filter(Boolean).join(' · ')
      return `${heading}\n\n${text}`
    })
    .filter(Boolean)
  if (!notes.length) return body
  return `${body ? `${body}\n\n` : ''}## Comments from Jira\n\n${notes.join('\n\n---\n\n')}`
}

function formatCommentDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${formatJqlDate(date)} UTC`
}
