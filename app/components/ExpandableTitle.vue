<script setup lang="ts">
import { ChevronUp } from '@lucide/vue'

/**
 * A title kept to one line, with a "…" of its own when it does not fit. The title itself is
 * the caller's (a link, a button) and goes where it always went; the "…" is a separate button
 * that unfolds the whole title, wrapped over as many lines as it needs, and folds it back.
 * Whether it fits is measured, so the "…" only shows when something is actually cut off.
 */
const props = defineProps<{ text: string }>()

const clip = ref<HTMLElement | null>(null)
const expanded = ref(false)
const overflowing = ref(false)

function measure() {
  const element = clip.value
  if (!element || expanded.value) return
  overflowing.value = element.scrollWidth > element.clientWidth + 1
}
let observer: ResizeObserver | null = null
onMounted(() => {
  observer = new ResizeObserver(() => measure())
  if (clip.value) observer.observe(clip.value)
  measure()
})
onBeforeUnmount(() => observer?.disconnect())
watch(() => props.text, () => nextTick(measure))
watch(expanded, value => { if (!value) nextTick(measure) })
</script>

<template>
  <span class="flex min-w-0 items-baseline gap-1">
    <span ref="clip" class="min-w-0" :class="expanded ? 'whitespace-normal break-words' : 'overflow-hidden whitespace-nowrap'"><slot /></span>
    <button
      v-if="overflowing && !expanded"
      type="button"
      class="focus-ring muted shrink-0 rounded px-1 leading-none font-bold hover:bg-[var(--panel-strong)] hover:text-[var(--ink)]"
      :aria-label="`Show the whole title: ${text}`"
      :title="text"
      data-expand-title
      @click.stop.prevent="expanded = true"
    >…</button>
    <button
      v-else-if="expanded"
      type="button"
      class="focus-ring muted grid size-4 shrink-0 self-center place-items-center rounded hover:bg-[var(--panel-strong)] hover:text-[var(--ink)]"
      aria-label="Shorten the title again"
      data-collapse-title
      @click.stop.prevent="expanded = false"
    ><ChevronUp :size="12" aria-hidden="true" /></button>
  </span>
</template>
