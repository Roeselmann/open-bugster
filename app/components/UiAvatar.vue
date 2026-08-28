<script setup lang="ts">
import { CATEGORY_TONE_CLASSES } from '~~/shared/utils/constants'
import { categoryColors } from '~~/shared/types/domain'

const props = withDefaults(defineProps<{
  person: { firstName?: string | null; lastName?: string | null; email: string } | null
  size?: 'sm' | 'md' | 'lg'
  /** Dims the avatar for an account that has not accepted its invitation yet. */
  muted?: boolean
}>(), { size: 'md', muted: false })

const label = computed(() => (props.person ? displayName(props.person) : 'Unassigned'))

/**
 * A stable colour per address. The tone classes are hand-written CSS, so they have to be
 * picked from `CATEGORY_TONE_CLASSES` rather than assembled as Tailwind strings here.
 */
const tone = computed(() => {
  const email = props.person?.email || ''
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
  <span
    class="grid shrink-0 place-items-center rounded-full font-bold uppercase tracking-tight"
    :class="[sizing, person ? tone : 'border border-dashed border-[var(--line)] text-[var(--muted)]', muted ? 'opacity-60' : '']"
    :title="label"
    :aria-label="label"
  >{{ person ? initials(person) : '—' }}</span>
</template>
