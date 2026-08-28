<script setup lang="ts">
import { Bot, Check, Copy, Plus, TriangleAlert, Webhook } from '@lucide/vue'

interface WebhookRecord {
  id: string
  boardId: string
  url: string
  events: string[]
  enabled: boolean
  description: string
  createdAt: string
  disabledAt: string | null
  consecutiveFailures: number
  lastDeliveryAt: string | null
}

interface DeliveryRecord {
  id: string
  event: string
  at: string
  attempt: number
  status: number | null
  error: string | null
  durationMs: number | null
}

const { boardId } = useCurrentBoard()
const { notify } = useNotify()

const allEvents = [
  'ticket.created', 'ticket.updated', 'ticket.moved', 'ticket.archived', 'ticket.restored',
  'comment.added', 'import.completed',
] as const

const hooks = ref<WebhookRecord[]>([])
const loading = ref(true)
const minted = ref<{ webhook: WebhookRecord; secret: string } | null>(null)
const copied = ref(false)
const creating = ref(false)
const form = reactive({ url: '', description: '', events: ['ticket.created'] as string[] })

/** Which webhook's delivery log is open. Loaded on demand — most of the time nobody looks. */
const openDeliveries = ref<string | null>(null)
const deliveries = ref<DeliveryRecord[]>([])

async function load() {
  if (!boardId.value) return
  loading.value = true
  try {
    const response = await $fetch<{ webhooks: WebhookRecord[] }>(`/api/boards/${boardId.value}/webhooks`)
    hooks.value = response.webhooks
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    loading.value = false
  }
}
watch(boardId, load, { immediate: true })

function toggleEvent(event: string) {
  form.events = form.events.includes(event) ? form.events.filter(held => held !== event) : [...form.events, event]
}

async function create() {
  if (!form.url.trim() || !form.events.length || creating.value) return
  creating.value = true
  try {
    minted.value = await $fetch<{ webhook: WebhookRecord; secret: string }>(`/api/boards/${boardId.value}/webhooks`, {
      method: 'POST',
      body: { url: form.url.trim(), description: form.description.trim(), events: form.events },
    })
    copied.value = false
    form.url = ''
    form.description = ''
    form.events = ['ticket.created']
    await load()
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    creating.value = false
  }
}

async function setEnabled(hook: WebhookRecord, enabled: boolean) {
  try {
    await $fetch(`/api/webhooks/${hook.id}`, { method: 'PATCH', body: { enabled } })
    await load()
  } catch (error) {
    notify('error', errorText(error))
  }
}

async function remove(hook: WebhookRecord) {
  try {
    await $fetch(`/api/webhooks/${hook.id}`, { method: 'DELETE' })
    notify('success', 'The webhook was removed.')
    if (openDeliveries.value === hook.id) openDeliveries.value = null
    await load()
  } catch (error) {
    notify('error', errorText(error))
  }
}

async function showDeliveries(hook: WebhookRecord) {
  if (openDeliveries.value === hook.id) {
    openDeliveries.value = null
    return
  }
  try {
    const response = await $fetch<{ deliveries: DeliveryRecord[] }>(`/api/webhooks/${hook.id}/deliveries`)
    deliveries.value = response.deliveries
    openDeliveries.value = hook.id
  } catch (error) {
    notify('error', errorText(error))
  }
}

async function copySecret() {
  if (!minted.value) return
  try {
    await navigator.clipboard.writeText(minted.value.secret)
    copied.value = true
  } catch {
    notify('error', 'Your browser would not let the page copy. Select the secret and copy it by hand.')
  }
}

const timeFormat = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const when = (value: string | null) => (value ? timeFormat.format(new Date(value)) : '—')
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Automation</p>
      <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><Webhook :size="18" aria-hidden="true" /> Webhooks</h2>
      <p class="muted mt-1 text-sm">
        Tell another system when something happens here — a workflow tool, a chat channel, a build
        pipeline. Each delivery is signed, so the receiver can be sure it came from this board.
      </p>
    </header>

    <div class="space-y-5 px-5 py-5">
      <div v-if="minted" class="rounded-xl border border-[var(--line)] bg-[var(--accent-soft)] p-4">
        <p class="flex items-center gap-2 text-sm font-bold">
          <TriangleAlert :size="16" aria-hidden="true" /> Copy this signing secret now — it is not shown again.
        </p>
        <p class="muted mt-1 text-sm">
          The receiver needs it to check the <code class="font-mono text-xs">X-Bugster-Signature</code> header.
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <code class="surface-strong min-w-0 flex-1 overflow-x-auto rounded-lg px-3 py-2 font-mono text-xs">{{ minted.secret }}</code>
          <button
            type="button"
            class="focus-ring flex h-9 items-center gap-1.5 rounded-xl bg-[var(--ink)] px-3 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85"
            @click="copySecret"
          >
            <component :is="copied ? Check : Copy" :size="15" aria-hidden="true" /> {{ copied ? 'Copied' : 'Copy' }}
          </button>
          <button type="button" class="focus-ring muted h-9 rounded-xl px-3 text-sm font-semibold hover:text-[var(--ink)]" @click="minted = null">Done</button>
        </div>
      </div>

      <form class="space-y-4" @submit.prevent="create">
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block">
            <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Where to send it</span>
            <input v-model="form.url" required type="url" placeholder="https://n8n.example.com/webhook/bugster" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
          </label>
          <label class="block">
            <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">What it is</span>
            <input v-model="form.description" maxlength="200" placeholder="n8n — triage workflow" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
          </label>
        </div>

        <fieldset>
          <legend class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">When to send it</legend>
          <div class="flex flex-wrap gap-x-4 gap-y-1.5">
            <label v-for="event in allEvents" :key="event" class="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" :checked="form.events.includes(event)" class="focus-ring size-4 rounded" @change="toggleEvent(event)">
              <span class="font-mono text-xs">{{ event }}</span>
            </label>
          </div>
        </fieldset>

        <div class="flex justify-end">
          <button
            :disabled="creating || !form.url.trim() || !form.events.length"
            class="focus-ring flex h-10 items-center gap-1.5 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50"
          >
            <Plus :size="15" aria-hidden="true" /> {{ creating ? 'Adding…' : 'Add webhook' }}
          </button>
        </div>
      </form>

      <div v-if="!loading" class="space-y-2 border-t border-[var(--line)] pt-4">
        <div v-for="hook in hooks" :key="hook.id" class="surface-strong rounded-xl px-3 py-2.5">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="hook.url">{{ hook.url }}</span>
            <span v-if="hook.description" class="muted text-xs">{{ hook.description }}</span>
            <span v-if="!hook.enabled" class="rounded-md bg-rose-500/10 px-2 py-0.5 text-xs font-semibold text-rose-600">
              {{ hook.disabledAt ? 'switched off after repeated failures' : 'paused' }}
            </span>
            <button type="button" class="focus-ring muted rounded-lg px-2 py-1 text-xs font-semibold hover:text-[var(--ink)]" @click="showDeliveries(hook)">
              {{ openDeliveries === hook.id ? 'Hide attempts' : 'Attempts' }}
            </button>
            <button type="button" class="focus-ring muted rounded-lg px-2 py-1 text-xs font-semibold hover:text-[var(--ink)]" @click="setEnabled(hook, !hook.enabled)">
              {{ hook.enabled ? 'Pause' : 'Resume' }}
            </button>
            <button type="button" class="focus-ring rounded-lg px-2 py-1 text-xs font-semibold text-rose-600 transition hover:bg-rose-500/10" @click="remove(hook)">
              Remove
            </button>
          </div>
          <p class="muted mt-1 font-mono text-[11px]">{{ hook.events.join(' · ') }}</p>

          <ol v-if="openDeliveries === hook.id" class="mt-2 space-y-1 border-t border-[var(--line)] pt-2">
            <li v-for="delivery in deliveries" :key="delivery.id" class="muted flex flex-wrap items-baseline gap-2 text-xs">
              <span class="tabular-nums">{{ when(delivery.at) }}</span>
              <span class="font-mono">{{ delivery.event }}</span>
              <span :class="delivery.status && delivery.status < 400 ? 'font-semibold text-emerald-600' : 'font-semibold text-rose-600'">
                {{ delivery.status ?? 'no response' }}
              </span>
              <span v-if="delivery.attempt > 1">attempt {{ delivery.attempt }}</span>
              <span v-if="delivery.error" class="truncate">{{ delivery.error }}</span>
              <span v-if="delivery.durationMs !== null" class="ml-auto tabular-nums">{{ delivery.durationMs }} ms</span>
            </li>
            <li v-if="!deliveries.length" class="muted text-xs">Nothing has been sent yet.</li>
          </ol>
        </div>
        <p v-if="!hooks.length" class="muted text-sm">
          No webhooks yet. Add one to have this board push its events somewhere instead of being polled.
        </p>
      </div>
    </div>
  </section>
</template>
