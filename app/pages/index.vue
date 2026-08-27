<script setup lang="ts">
definePageMeta({ middleware: 'home-board' })
</script>

<template>
  <div class="grid min-h-screen place-items-center px-6">
    <div class="surface max-w-md rounded-2xl p-7 text-center">
      <h1 class="font-bold">No board yet</h1>
      <p class="muted mt-2 text-sm">Open-Bugster could not find a board. Restart the app to create the default board.</p>
    </div>
  </div>
</template>
