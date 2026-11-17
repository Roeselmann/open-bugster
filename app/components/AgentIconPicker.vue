<script setup lang="ts">
import { Type } from '@lucide/vue'
import { AGENT_ICON_LABELS, agentIcons, type AgentIcon } from '~~/shared/utils/agent-icons'

/** One of the agent faces, or none — in which case the agent keeps its initials. */
const model = defineModel<AgentIcon | null>({ required: true })
defineProps<{ name: string }>()
</script>

<template>
  <div role="radiogroup" :aria-label="`Icon for ${name || 'the agent'}`" class="flex flex-wrap gap-1.5">
    <button
      type="button"
      role="radio"
      :aria-checked="model === null"
      title="Initials"
      class="focus-ring grid size-10 place-items-center rounded-lg border transition"
      :class="model === null ? 'border-[var(--ink)] bg-[var(--panel-strong)]' : 'border-[var(--line)] hover:bg-[var(--panel-strong)]'"
      @click="model = null"
    >
      <Type :size="16" aria-hidden="true" />
      <span class="sr-only">Initials</span>
    </button>
    <button
      v-for="icon in agentIcons"
      :key="icon"
      type="button"
      role="radio"
      :aria-checked="model === icon"
      :title="AGENT_ICON_LABELS[icon]"
      class="focus-ring grid size-10 place-items-center rounded-lg border transition"
      :class="model === icon ? 'border-[var(--ink)] bg-[var(--panel-strong)]' : 'border-[var(--line)] hover:bg-[var(--panel-strong)]'"
      @click="model = icon"
    >
      <component :is="AGENT_ICON_COMPONENTS[icon]" :size="18" :stroke-width="2.25" aria-hidden="true" />
      <span class="sr-only">{{ AGENT_ICON_LABELS[icon] }}</span>
    </button>
  </div>
</template>
