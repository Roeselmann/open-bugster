<script setup lang="ts">
import { Bot, Check, Copy } from '@lucide/vue'

interface McpInfo {
  url: string
  transport: string
  tools: Array<{ name: string; title: string; description: string }>
}

const { notify } = useNotify()

const info = ref<McpInfo | null>(null)
const showTools = ref(false)
const copied = ref<'config' | 'url' | null>(null)

const { data } = await useFetch<McpInfo>('/api/mcp-info')
watchEffect(() => { info.value = data.value ?? null })

/**
 * The shape most clients take. The token is a placeholder rather than a real one: this panel
 * has no business holding a live credential, and pasting one in is a deliberate step.
 */
const config = computed(() => JSON.stringify({
  mcpServers: {
    'open-bugster': {
      url: info.value?.url ?? '',
      headers: { Authorization: 'Bearer bgs_your_token_here' },
    },
  },
}, null, 2))

async function copy(what: 'config' | 'url') {
  try {
    await navigator.clipboard.writeText(what === 'config' ? config.value : info.value?.url ?? '')
    copied.value = what
    setTimeout(() => { if (copied.value === what) copied.value = null }, 2000)
  } catch {
    notify('error', 'Your browser would not let the page copy. Select the text and copy it by hand.')
  }
}
</script>

<template>
  <div v-if="info" class="space-y-4 px-5 py-5">
    <div>
      <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Endpoint</span>
      <div class="flex flex-wrap items-center gap-2">
        <code class="surface-strong min-w-0 flex-1 overflow-x-auto rounded-lg px-3 py-2 font-mono text-xs">{{ info.url }}</code>
        <button
          type="button"
          class="focus-ring flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold transition hover:bg-[var(--accent-soft)]"
          @click="copy('url')"
        >
          <component :is="copied === 'url' ? Check : Copy" :size="15" aria-hidden="true" />
          {{ copied === 'url' ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <p class="muted mt-1.5 text-xs">Model Context Protocol over Streamable HTTP. Authenticate with an API token above.</p>
    </div>

    <div>
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="text-xs font-bold uppercase tracking-[.08em]">Client configuration</span>
        <button
          type="button"
          class="focus-ring flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition hover:bg-[var(--accent-soft)]"
          @click="copy('config')"
        >
          <component :is="copied === 'config' ? Check : Copy" :size="14" aria-hidden="true" />
          {{ copied === 'config' ? 'Copied' : 'Copy' }}
        </button>
      </div>
      <pre class="surface-strong overflow-x-auto rounded-lg px-3 py-2.5 font-mono text-xs leading-relaxed">{{ config }}</pre>
      <p class="muted mt-1.5 text-xs">Replace the placeholder with a token you minted above, then restart the client.</p>
    </div>

    <div>
      <button
        type="button"
        class="focus-ring flex items-center gap-1.5 rounded-lg text-xs font-bold uppercase tracking-[.08em]"
        :aria-expanded="showTools"
        @click="showTools = !showTools"
      >
        What an agent can do
        <span class="muted font-semibold tabular-nums">{{ info.tools.length }}</span>
        <span class="muted font-medium normal-case tracking-normal">{{ showTools ? '· hide' : '· show' }}</span>
      </button>

      <ul v-if="showTools" class="mt-3 space-y-2">
        <li v-for="tool in info.tools" :key="tool.name" class="text-sm">
          <code class="font-mono text-xs font-semibold">{{ tool.name }}</code>
          <p class="muted mt-0.5 text-xs leading-relaxed">{{ tool.description }}</p>
        </li>
      </ul>
    </div>

    <p class="muted border-t border-[var(--line)] pt-3 text-xs">
      An agent can only do what its token permits, and its label appears beside your name on
      everything it touches — in each ticket’s history and in the board’s audit trail.
    </p>
  </div>
</template>
