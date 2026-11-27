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
    title="macOS dictation types into any text field. It starts with the 🌐 / fn key pressed twice, or the microphone key (F5) on newer keyboards. If nothing happens, or your keyboard has neither, turn it on and pick a shortcut under System Settings → Keyboard → Dictation. Edit → Start Dictation works too."
  >
    <span>Dictate: press</span>
    <kbd class="rounded border border-[var(--line)] px-1 font-sans text-[11px]">🌐 / fn</kbd>
    <span>twice or</span>
    <kbd class="inline-flex items-center rounded border border-[var(--line)] px-1 py-px" aria-label="microphone key"><Mic :size="11" aria-hidden="true" /></kbd>
  </p>
</template>
