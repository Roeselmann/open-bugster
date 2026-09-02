<script setup lang="ts">
import { Upload } from '@lucide/vue'
import { PopoverClose, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import type { TicketTypeColor, TicketTypeIcon, TicketTypeIconName } from '~~/shared/types/domain'
import { ticketTypeIconNames } from '~~/shared/types/domain'
import { TICKET_TYPE_ICON_DATA_URL_MAX } from '~~/shared/utils/constants'
import { TICKET_TYPE_ICON_COMPONENTS } from '~/utils/ticketTypeIcons'

const props = withDefaults(defineProps<{
  modelValue: TicketTypeIcon
  /** The tone the badge preview is painted in, so the trigger looks like the card will. */
  color: TicketTypeColor
  name?: string
  disabled?: boolean
}>(), { name: 'Type', disabled: false })

const emit = defineEmits<{
  'update:modelValue': [value: TicketTypeIcon]
  error: [text: string]
}>()

const open = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const reading = ref(false)

function pick(name: TicketTypeIconName) {
  emit('update:modelValue', { kind: 'lucide', name })
  open.value = false
}

/**
 * The centre square of the picture, shrunk to a small PNG. Done here rather than on the
 * server because the server has no image library and needs none: what it receives is
 * already the final bytes, and the size cap says how big those may be. A large or busy
 * picture is retried smaller before giving up.
 */
async function cropToPngDataUrl(file: File, size: number): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas')
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
    return canvas.toDataURL('image/png')
  } finally {
    bitmap.close()
  }
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  reading.value = true
  try {
    let dataUrl = ''
    for (const size of [128, 96, 64]) {
      dataUrl = await cropToPngDataUrl(file, size)
      if (dataUrl.length <= TICKET_TYPE_ICON_DATA_URL_MAX) break
    }
    if (dataUrl.length > TICKET_TYPE_ICON_DATA_URL_MAX) {
      emit('error', 'That image is too detailed to fit as an icon — try a simpler one.')
      return
    }
    emit('update:modelValue', { kind: 'image', dataUrl })
    open.value = false
  } catch {
    emit('error', 'That file could not be read as an image.')
  } finally {
    reading.value = false
  }
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      class="focus-ring surface-strong flex h-8 items-center gap-2 rounded-lg px-2 text-xs outline-none transition hover:border-[color-mix(in_srgb,var(--line)_55%,var(--accent))] disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="disabled"
      :aria-label="`Icon of ${name}`"
    >
      <TicketTypeBadge :type="{ name, color, icon: modelValue }" size="sm" untitled />
      <span class="muted">Icon</span>
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent
        align="start"
        :side-offset="6"
        :collision-padding="12"
        class="ui-popover z-[100] w-[min(19rem,calc(100vw-1.5rem))] rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] p-3 text-[var(--ink)] shadow-[0_18px_45px_rgba(0,0,0,.16),0_3px_12px_rgba(0,0,0,.08)]"
      >
        <p class="mb-2 text-xs font-bold uppercase tracking-[.08em]">Pick an icon</p>
        <div class="grid grid-cols-6 gap-1">
          <PopoverClose
            v-for="iconName in ticketTypeIconNames"
            :key="iconName"
            class="focus-ring grid size-10 place-items-center rounded-lg outline-none transition hover:bg-[var(--accent-soft)]"
            :class="modelValue.kind === 'lucide' && modelValue.name === iconName ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : ''"
            :aria-label="iconName"
            :title="iconName"
            @click="pick(iconName)"
          >
            <component :is="TICKET_TYPE_ICON_COMPONENTS[iconName]" :size="18" aria-hidden="true" />
          </PopoverClose>
        </div>

        <div class="mt-3 border-t border-[var(--line)] pt-3">
          <button
            type="button"
            class="focus-ring flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--line)] text-sm font-semibold hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-50"
            :disabled="reading"
            @click="fileInput?.click()"
          >
            <Upload :size="15" aria-hidden="true" /> {{ reading ? 'Reading…' : 'Upload an image' }}
          </button>
          <p class="muted mt-1.5 text-[11px]">The middle square of the picture becomes the icon.</p>
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="sr-only" @change="onFile">
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
