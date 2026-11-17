import { Bot, BotMessageSquare, BrainCircuit, Bug, Coffee, Ghost, Rocket, Satellite, Squirrel, WandSparkles } from '@lucide/vue'
import type { Component } from 'vue'
import type { AgentIcon } from '~~/shared/utils/agent-icons'

export const AGENT_ICON_COMPONENTS: Record<AgentIcon, Component> = {
  'bot': Bot,
  'chatty': BotMessageSquare,
  'big-brain': BrainCircuit,
  'ghost': Ghost,
  'rocket': Rocket,
  'satellite': Satellite,
  'squirrel': Squirrel,
  'bug-hunter': Bug,
  'wizard': WandSparkles,
  'coffee': Coffee,
}
