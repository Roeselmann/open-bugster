<script setup lang="ts">
import type { TicketType, TicketTypeColor, TicketTypeIcon, TicketTypeIconRef } from '~~/shared/types/domain'
import { CATEGORY_TONE_CLASSES } from '~~/shared/utils/constants'
import { TICKET_TYPE_ICON_COMPONENTS } from '~/utils/ticketTypeIcons'
import { TICKET_TYPES_KEY } from '~/utils/ticketTypes'

const props = withDefaults(defineProps<{
  /**
   * A full type, the slim reference a ticket carries (its image is then looked up by id), or
   * an unsaved draft from the settings form, which has no id yet.
   */
  type: { id?: string; name: string; color: TicketTypeColor; icon: TicketTypeIcon | TicketTypeIconRef }
  /** `md` is the card's; `sm` fits a settings row or a select option. */
  size?: 'sm' | 'md'
  /** Without it the badge names the type on hover, which a list beside the name does not need. */
  untitled?: boolean
  /**
   * Swaps the tone's two colours. On a card already painted in the type's tone the plain
   * badge would melt into it; inverted, it is the one solid mark on the card.
   */
  inverted?: boolean
}>(), { size: 'md', untitled: false, inverted: false })

// A ticket's type reference leaves the image bytes out; the page that lists tickets provides
// the workspace's full types, and the badge finds the picture there by id.
const providedTypes = inject(TICKET_TYPES_KEY, ref<TicketType[]>([]))
const imageUrl = computed(() => {
  if (props.type.icon.kind !== 'image') return null
  if ('dataUrl' in props.type.icon) return props.type.icon.dataUrl
  const full = props.type.id ? providedTypes.value.find(type => type.id === props.type.id) : undefined
  return full?.icon.kind === 'image' ? full.icon.dataUrl : null
})

const sizing = computed(() => (props.size === 'sm' ? 'size-6' : 'size-8'))

/**
 * A type without a colour still needs a visible mark: plain, it is a quiet disc on the
 * panel; inverted — on the card — it is the one solid ink-coloured dot.
 */
const toneClass = computed(() => {
  if (props.type.color !== 'none') return CATEGORY_TONE_CLASSES[props.type.color]
  return props.inverted ? 'bg-[var(--ink)] text-[var(--canvas)]' : 'bg-[var(--panel)] text-[var(--ink)]'
})
const invertedStyle = computed(() => (props.inverted && props.type.color !== 'none'
  ? { backgroundColor: 'var(--tone-fg)', color: 'var(--tone-bg)' }
  : undefined))
const iconSize = computed(() => (props.size === 'sm' ? 13 : 16))
</script>

<template>
  <!--
    A round mark in the type's tone. An uploaded image already arrived square, so it only
    has to be clipped to the circle; a lucide icon sits on the tone's background.
  -->
  <span
    class="grid shrink-0 place-items-center overflow-hidden rounded-full border border-black/5 dark:border-white/10"
    :class="[sizing, toneClass]"
    :style="invertedStyle"
    :title="untitled ? undefined : type.name"
    :aria-label="untitled ? undefined : `Type: ${type.name}`"
    :aria-hidden="untitled ? 'true' : undefined"
  >
    <img v-if="imageUrl" :src="imageUrl" alt="" class="size-full object-cover" draggable="false">
    <component :is="TICKET_TYPE_ICON_COMPONENTS[type.icon.kind === 'lucide' ? type.icon.name : 'Image']" v-else :size="iconSize" :stroke-width="2.25" aria-hidden="true" />
  </span>
</template>
