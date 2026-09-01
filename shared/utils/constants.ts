import type { CategoryColor, TicketPriority } from '../types/domain'

/**
 * The name the first workspace is seeded with. The workspace switcher treats a lone
 * workspace still carrying it (and no description) as untouched and stays hidden.
 */
export const DEFAULT_WORKSPACE_NAME = 'Workspace'

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
