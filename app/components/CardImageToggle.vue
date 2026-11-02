<script setup lang="ts">
import { Check } from '@lucide/vue'

/**
 * The tick over a picture in the editor's side column that puts it on the ticket's card —
 * an image attachment or a link's rendered preview alike. Read-only, only a ticked one shows.
 */
defineProps<{ checked: boolean; canEdit: boolean; name: string }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    v-if="canEdit || checked"
    type="button"
    role="checkbox"
    :aria-checked="checked"
    :disabled="!canEdit"
    :aria-label="checked ? `${name} is shown on the card` : `Show ${name} on the card`"
    :title="checked ? 'Shown on the card' : 'Show on the card'"
    class="focus-ring absolute left-1.5 top-1.5 z-10 flex items-center gap-1 rounded-md bg-[var(--panel-strong)]/90 px-1.5 py-1 text-[10px] font-semibold shadow-sm disabled:cursor-default"
    @click.stop="emit('toggle')"
  >
    <span class="grid size-3.5 place-items-center rounded-[4px] border" :class="checked ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line)] bg-[var(--panel-strong)]'">
      <Check v-if="checked" :size="10" :stroke-width="3" />
    </span>
    Card
  </button>
</template>
