<script setup lang="ts">
definePageMeta({ middleware: 'home-board' })

const { instanceAdmin } = useAuth()
</script>

<template>
  <div class="min-h-screen">
    <AppHeader />
    <main class="grid place-items-center px-6 py-24">
      <div class="surface max-w-md rounded-2xl p-7 text-center">
        <h1 class="text-lg font-bold">No board yet</h1>
        <p v-if="instanceAdmin" class="muted mt-2 text-sm">
          There is no board on this instance yet, or you are not a member of one. Restart the app to
          create the default board.
        </p>
        <p v-else class="muted mt-2 text-sm">
          You are not a member of any board yet. Ask an administrator to add you to one — they can do
          that under Board settings → Members.
        </p>
      </div>
    </main>
  </div>
</template>
