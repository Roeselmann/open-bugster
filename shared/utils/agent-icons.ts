/**
 * The faces an administrator can give an agent. Keys are what is stored; the icons they map
 * to live in `app/utils/agent-icon-components.ts`, so the server never imports a component.
 */
export const agentIcons = [
  'bot', 'chatty', 'big-brain', 'ghost', 'rocket', 'satellite', 'squirrel', 'bug-hunter', 'wizard', 'coffee',
] as const

export type AgentIcon = typeof agentIcons[number]

export const AGENT_ICON_LABELS: Record<AgentIcon, string> = {
  'bot': 'Classic bot',
  'chatty': 'Chatterbox',
  'big-brain': 'Big brain',
  'ghost': 'Ghost in the machine',
  'rocket': 'Ships it',
  'satellite': 'Watches from orbit',
  'squirrel': 'Busy squirrel',
  'bug-hunter': 'Bug hunter',
  'wizard': 'Wizard',
  'coffee': 'Runs on coffee',
}

export function isAgentIcon(value: unknown): value is AgentIcon {
  return typeof value === 'string' && (agentIcons as readonly string[]).includes(value)
}
