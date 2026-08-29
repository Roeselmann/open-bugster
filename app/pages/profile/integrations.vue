<script setup lang="ts">
import { Bot, Terminal } from '@lucide/vue'

const { boards } = useBoards()
</script>

<template>
  <div class="space-y-6">
    <section class="surface rounded-2xl">
      <header class="border-b border-[var(--line)] px-5 py-4">
        <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Integrations</p>
        <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><Terminal :size="18" aria-hidden="true" /> API tokens</h2>
        <p class="muted mt-1 text-sm">
          For the API, for a workflow tool, or for connecting an agent. Everything a token does is
          recorded against you, with its label beside it.
          <NuxtLink to="/api/v1/docs" target="_blank" class="focus-ring rounded font-semibold underline underline-offset-2">API reference</NuxtLink>
        </p>
      </header>
      <ApiTokenManager :boards="boards" />
    </section>

    <!-- The same token serves both; the panel below only says where to point it. -->
    <section class="surface rounded-2xl">
      <header class="border-b border-[var(--line)] px-5 py-4">
        <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Integrations</p>
        <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><Bot :size="18" aria-hidden="true" /> Connect an AI agent</h2>
        <p class="muted mt-1 text-sm">
          Point Claude, Cursor or anything else that speaks MCP at this instance, and it can read
          and work the boards you can. Use one of the tokens above.
        </p>
      </header>
      <McpConnection />
    </section>
  </div>
</template>
