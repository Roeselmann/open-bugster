<script setup lang="ts">
import { CATEGORY_TONE_CLASSES } from '~~/shared/utils/constants'
import { categoryColors } from '~~/shared/types/domain'
import { isAgentIcon } from '~~/shared/utils/agent-icons'

const props = withDefaults(defineProps<{
  person: {
    firstName?: string | null; lastName?: string | null; email?: string | null
    anonymizedAt?: string | null
    /** A machine principal. Drawn differently, so a bot never passes for a colleague. */
    isService?: boolean
    /** An uploaded portrait, already square. Drawn instead of the initials. */
    avatarUrl?: string | null
    /** An agent's chosen icon, drawn instead of its initials. */
    icon?: string | null
  } | null
  size?: 'sm' | 'md' | 'lg'
  /** Dims the avatar for an account that has not accepted its invitation yet. */
  muted?: boolean
}>(), { size: 'md', muted: false })

const isService = computed(() => Boolean(props.person?.isService))
const iconComponent = computed(() => {
  const icon = props.person?.icon
  return isService.value && isAgentIcon(icon) ? AGENT_ICON_COMPONENTS[icon] : null
})
/** A portrait that failed to load falls back to the initials rather than a broken image. */
const failed = ref(false)
watch(() => props.person?.avatarUrl, () => { failed.value = false })
const photo = computed(() => (!failed.value && props.person?.avatarUrl) || null)
const iconSize = computed(() => ({ sm: 13, md: 16, lg: 20 }[props.size]))
const label = computed(() => {
  if (!props.person) return 'Unassigned'
  return isService.value ? `${displayName(props.person)} · automated` : displayName(props.person)
})

/**
 * A stable colour per address. An erased account has none left, so it falls to the first
 * tone — which reads as the neutral one it should be. The tone classes are hand-written
 * CSS, so they have to be picked from `CATEGORY_TONE_CLASSES` rather than assembled as
 * Tailwind strings here.
 */
const tone = computed(() => {
  // An agent has no address, so its name picks the colour — otherwise every bot shares one.
  const email = props.person?.email || (isService.value ? props.person?.firstName || '' : '')
  let hash = 0
  for (let index = 0; index < email.length; index += 1) hash = (hash * 31 + email.charCodeAt(index)) % 997
  return CATEGORY_TONE_CLASSES[categoryColors[hash % categoryColors.length]!]
})

const sizing = computed(() => ({
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-[11px]',
  lg: 'size-10 text-sm',
}[props.size]))
</script>

<template>
  <!--
    A service identity gets a square rather than a circle and a monospace mark. Colour alone
    would not do it: half the point is that somebody scanning a board can tell at a glance
    that a bot filed something, and that has to survive being colour-blind.
  -->
  <span
    class="grid shrink-0 place-items-center font-bold uppercase tracking-tight"
    :class="[
      sizing,
      isService ? 'rounded-md font-mono' : 'rounded-full',
      photo ? 'overflow-hidden bg-[var(--panel-strong)]' : person ? tone : 'border border-dashed border-[var(--line)] text-[var(--muted)]',
      muted ? 'opacity-60' : '',
    ]"
    :title="label"
    role="img"
    :aria-label="label"
  >
    <img v-if="photo" :src="photo" alt="" class="size-full object-cover" loading="lazy" decoding="async" @error="failed = true">
    <component :is="iconComponent" v-else-if="iconComponent" :size="iconSize" :stroke-width="2.25" aria-hidden="true" />
    <template v-else>{{ person ? initials(person) : '—' }}</template>
  </span>
</template>
