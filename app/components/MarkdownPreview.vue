<script setup lang="ts">
import { Download, LoaderCircle, X } from '@lucide/vue'
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { Attachment } from '~~/shared/types/domain'

const props = defineProps<{ attachment: Attachment }>()
const emit = defineEmits<{ close: [] }>()

const source = ref<string | null>(null)
const failed = ref(false)

// The file is served as a download, but fetch reads it all the same; MarkdownView escapes
// any raw HTML in it, so a file nobody vetted is as safe to show as a description.
onMounted(async () => {
  try {
    source.value = await $fetch<string>(props.attachment.url, { responseType: 'text' })
  } catch {
    failed.value = true
  }
})
</script>

<template>
  <DialogRoot :open="true" @update:open="open => !open && emit('close')">
    <DialogPortal>
      <DialogOverlay class="ui-dialog-overlay fixed inset-0 z-[80] bg-black/40 backdrop-blur-[2px]" />
      <DialogContent class="ui-dialog-content surface fixed left-1/2 top-1/2 z-[81] flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl shadow-2xl outline-none">
        <header class="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3">
          <div class="min-w-0 flex-1">
            <DialogTitle class="truncate text-sm font-bold" :title="attachment.filename">{{ attachment.filename }}</DialogTitle>
            <DialogDescription class="sr-only">Markdown preview</DialogDescription>
          </div>
          <a :href="attachment.url" :download="attachment.filename" class="focus-ring muted grid size-8 shrink-0 place-items-center rounded-lg hover:bg-[var(--panel-strong)]" :aria-label="`Download ${attachment.filename}`" title="Download"><Download :size="16" /></a>
          <DialogClose as-child>
            <button type="button" class="focus-ring muted grid size-8 shrink-0 place-items-center rounded-lg hover:bg-[var(--panel-strong)]" aria-label="Close preview"><X :size="17" /></button>
          </DialogClose>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed sm:px-6">
          <p v-if="failed" class="text-sm text-rose-600">The file could not be loaded.</p>
          <p v-else-if="source === null" class="muted flex items-center gap-2 text-sm"><LoaderCircle :size="15" class="animate-spin" /> Loading…</p>
          <p v-else-if="!source.trim()" class="muted text-sm">The file is empty.</p>
          <MarkdownView v-else :source="source" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
