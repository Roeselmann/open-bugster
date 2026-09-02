import type { CategoryColor, TicketPriority, TicketTypeColor, TicketTypeIcon } from '../types/domain'

/**
 * The name the first workspace is seeded with. The workspace switcher treats a lone
 * workspace still carrying it (and no description) as untouched and stays hidden.
 */
export const DEFAULT_WORKSPACE_NAME = 'Workspace'

/** The types every workspace starts with. Ordinary rows: each workspace may rename or drop them. */
export const DEFAULT_TICKET_TYPES: ReadonlyArray<{ name: string; color: TicketTypeColor; icon: TicketTypeIcon }> = [
  { name: 'Ticket', color: 'neutral', icon: { kind: 'lucide', name: 'Ticket' } },
  { name: 'Email', color: 'blue', icon: { kind: 'lucide', name: 'Mail' } },
  { name: 'Social Post', color: 'fuchsia', icon: { kind: 'lucide', name: 'Megaphone' } },
  { name: 'Todo', color: 'emerald', icon: { kind: 'lucide', name: 'ListTodo' } },
  { name: 'Idea', color: 'amber', icon: { kind: 'lucide', name: 'Lightbulb' } }
]

/**
 * The longest data URL an uploaded type icon may be. The browser crops and shrinks the image
 * to a 128-pixel square before it is sent, which lands well under this; the cap is what keeps
 * an unexpected payload from turning a workspace's type list into a megabyte response.
 */
export const TICKET_TYPE_ICON_DATA_URL_MAX = 64 * 1024

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent'
}



export const CATEGORY_COLOR_LABELS: Record<CategoryColor, string> = {
  neutral: 'Neutral',
  rose: 'Rose',
  amber: 'Amber',
  emerald: 'Emerald',
  teal: 'Teal',
  blue: 'Blue',
  violet: 'Violet',
  fuchsia: 'Fuchsia'
}

/**
 * Hand-written CSS in `app/assets/css/main.css`, not Tailwind utilities: classes that only
 * ever exist as strings in this file are invisible to the Tailwind content scan, which is
 * exactly how the old lane colours ended up rendering nothing.
 */
export const CATEGORY_TONE_CLASSES: Record<CategoryColor, string> = {
  neutral: 'tone tone-neutral',
  rose: 'tone tone-rose',
  amber: 'tone tone-amber',
  emerald: 'tone tone-emerald',
  teal: 'tone tone-teal',
  blue: 'tone tone-blue',
  violet: 'tone tone-violet',
  fuchsia: 'tone tone-fuchsia'
}
