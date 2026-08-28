<script setup lang="ts">
import { Bot, Globe, ScrollText, Terminal } from '@lucide/vue'
import type { Person } from '~~/shared/types/domain'

interface AuditEntry {
  id: string
  at: string
  principalId: string | null
  principal: Person | null
  agentId: string | null
  tokenId: string | null
  channel: 'web' | 'api' | 'mcp'
  operation: string
  targetType: string
  targetId: string | null
  changes: Record<string, unknown>
  result: 'ok' | 'denied' | 'error'
  ip: string | null
}

const { boardId } = useCurrentBoard()
const { notify } = useNotify()

const entries = ref<AuditEntry[]>([])
const loading = ref(true)
const filter = ref('')

async function load() {
  if (!boardId.value) return
  loading.value = true
  try {
    const response = await $fetch<{ entries: AuditEntry[] }>(`/api/boards/${boardId.value}/audit`, {
      query: { limit: 200 },
    })
    entries.value = response.entries
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    loading.value = false
  }
}
watch(boardId, load, { immediate: true })

const shown = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  if (!needle) return entries.value
  return entries.value.filter(entry =>
    entry.operation.toLowerCase().includes(needle)
    || (entry.principal ? displayName(entry.principal).toLowerCase().includes(needle) : false)
    || (entry.agentId || '').toLowerCase().includes(needle))
})

/** Where the call came from. The icon carries it, so the row stays scannable. */
const channelIcon = { web: Globe, api: Terminal, mcp: Bot }
const channelLabel = { web: 'from the browser', api: 'through the API', mcp: 'through an agent' }

const resultTone: Record<AuditEntry['result'], string> = {
  ok: 'text-[var(--muted)]',
  denied: 'font-semibold text-amber-600',
  error: 'font-semibold text-rose-600',
}

const timeFormat = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Only what the operation chose to record ever reaches here — never a secret. */
function summarize(changes: Record<string, unknown>): string {
  const entries_ = Object.entries(changes)
  if (!entries_.length) return ''
  return entries_.map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`).join(' · ')
}
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Accountability</p>
      <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><ScrollText :size="18" aria-hidden="true" /> Audit trail</h2>
      <p class="muted mt-1 text-sm">
        Every change made on this board, and every attempt that was refused — from the browser, the
        API or an agent. Held by id rather than by name, so anonymizing somebody empties this of
        anything that identifies them without losing the history.
      </p>
    </header>

    <div class="px-5 py-4">
      <label class="block">
        <span class="sr-only">Filter</span>
        <input
          v-model="filter"
          placeholder="Filter by operation, person or agent…"
          class="focus-ring surface-strong h-10 w-full rounded-xl px-3 text-sm outline-none"
        >
      </label>
    </div>

    <div v-if="loading" class="muted px-5 pb-6 text-sm">Loading…</div>

    <ol v-else-if="shown.length" class="divide-y divide-[var(--line)] border-t border-[var(--line)]">
      <li v-for="entry in shown" :key="entry.id" class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-5 py-2.5 text-sm">
        <span class="muted shrink-0 text-xs tabular-nums">{{ timeFormat.format(new Date(entry.at)) }}</span>

        <component :is="channelIcon[entry.channel]" :size="14" class="muted shrink-0 self-center" :aria-label="channelLabel[entry.channel]" />

        <span class="font-semibold">{{ entry.principal ? displayName(entry.principal) : 'somebody' }}</span>
        <span v-if="entry.agentId" class="muted text-xs">via {{ entry.agentId }}</span>

        <code class="font-mono text-xs">{{ entry.operation }}</code>

        <span v-if="entry.result !== 'ok'" :class="resultTone[entry.result]" class="text-xs">
          {{ entry.result === 'denied' ? 'refused' : 'failed' }}
        </span>

        <span v-if="summarize(entry.changes)" class="muted min-w-0 flex-1 truncate text-xs" :title="summarize(entry.changes)">
          {{ summarize(entry.changes) }}
        </span>
      </li>
    </ol>

    <p v-else class="muted px-5 pb-6 text-sm">
      {{ filter ? 'Nothing matches that.' : 'Nothing has been recorded on this board yet.' }}
    </p>
  </section>
</template>
