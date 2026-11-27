<script setup lang="ts">
import { Mic } from '@lucide/vue'

// macOS dictation works in every text field, but no web page can start it: there is no
// attribute or API for that. The keyboard shortcut is the only way in, so this names it.
// Phones and tablets show a microphone on their own keyboard and need no hint; iPadOS
// reports itself as a Mac, which its touch points give away.
const isMac = ref(false)
onMounted(() => {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || ''
  isMac.value = /mac/i.test(platform) && navigator.maxTouchPoints < 2
})
</script>

<template>
  <p
    v-if="isMac"
    class="muted flex items-center gap-1.5 text-xs"
    title="macOS dictation types into any text field. If nothing happens, turn it on under System Settings → Keyboard → Dictation, where the shortcut can also be changed."
  >
    <Mic :size="13" aria-hidden="true" />
    <span>Press <kbd class="rounded border border-[var(--line)] px-1 font-sans text-[11px]">fn</kbd> twice to dictate</span>
  </p>
</template>
