<script setup lang="ts">
import { Bot, Check, Copy, Plus, TriangleAlert } from '@lucide/vue'
import type { BoardSummary } from '~~/shared/types/domain'

interface ApiToken {
  id: string
  principalId: string
  name: string
  agentLabel: string | null
  scopes: string[]
  boardId: string | null
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

const props = withDefaults(defineProps<{
  /** Whose tokens these are. Omitted means the signed-in account's own. */
  principalId?: string | null
  /** Boards the token can be pinned to. */
  boards?: BoardSummary[]
}>(), { principalId: null, boards: () => [] })

const { notify } = useNotify()

const tokens = ref<ApiToken[]>([])
const loading = ref(true)

/**
 * The one moment the token exists in the clear. Only a hash is stored, so once this is
 * dismissed there is no way to show it again — which the copy panel has to say plainly,
 * because the alternative is somebody closing it and quietly losing access.
 */
const minted = ref<{ token: ApiToken; secret: string } | null>(null)
const copied = ref(false)

const creating = ref(false)
const form = reactive({ name: '', agentLabel: '', scopes: ['read'] as string[], boardId: '' })

const scopeHelp: Record<string, string> = {
  read: 'See boards, tickets and comments.',
  write: 'Create, edit, move and comment.',
  admin: 'Board settings, and instance administration where the person already has it.',
}

const query = computed(() => (props.principalId ? { principalId: props.principalId } : {}))

async function load() {
  loading.value = true
  try {
    const response = await $fetch<{ tokens: ApiToken[] }>('/api/tokens', { query: query.value })
    tokens.value = response.tokens
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.principalId, load)

function toggleScope(scope: string) {
  form.scopes = form.scopes.includes(scope)
    ? form.scopes.filter(held => held !== scope)
    : [...form.scopes, scope]
}

async function create() {
  if (!form.name.trim() || !form.scopes.length || creating.value) return
  creating.value = true
  try {
    const result = await $fetch<{ token: ApiToken; secret: string }>('/api/tokens', {
      method: 'POST',
      body: {
        name: form.name.trim(),
        agentLabel: form.agentLabel.trim() || null,
        scopes: form.scopes,
        boardId: form.boardId || null,
        ...(props.principalId ? { principalId: props.principalId } : {}),
      },
    })
    minted.value = result
    copied.value = false
    form.name = ''
    form.agentLabel = ''
    form.scopes = ['read']
    form.boardId = ''
    await load()
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    creating.value = false
  }
}

async function copySecret() {
  if (!minted.value) return
  try {
    await navigator.clipboard.writeText(minted.value.secret)
    copied.value = true
  } catch {
    notify('error', 'Your browser would not let the page copy. Select the token and copy it by hand.')
  }
}

async function revoke(token: ApiToken) {
  try {
    await $fetch(`/api/tokens/${token.id}`, { method: 'DELETE' })
    notify('success', `“${token.name}” stopped working.`)
    await load()
  } catch (error) {
    notify('error', errorText(error))
  }
}

const dateFormat = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' })
const when = (value: string | null) => (value ? dateFormat.format(new Date(value)) : null)
const boardName = (id: string | null) => props.boards.find(board => board.id === id)?.name ?? null
const live = computed(() => tokens.value.filter(token => !token.revokedAt))
</script>

<template>
  <div class="space-y-5 px-5 py-5">
    <!-- Shown once, and never again. -->
    <div v-if="minted" class="rounded-xl border border-[var(--line)] bg-[var(--accent-soft)] p-4">
      <p class="flex items-center gap-2 text-sm font-bold">
        <TriangleAlert :size="16" aria-hidden="true" /> Copy this now — it is not shown again.
      </p>
      <p class="muted mt-1 text-sm">Only a hash is stored, so nobody can look it up later. Losing it means making a new one.</p>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <code class="surface-strong min-w-0 flex-1 overflow-x-auto rounded-lg px-3 py-2 font-mono text-xs">{{ minted.secret }}</code>
        <button
          type="button"
          class="focus-ring flex h-9 items-center gap-1.5 rounded-xl bg-[var(--ink)] px-3 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85"
          @click="copySecret"
        >
          <component :is="copied ? Check : Copy" :size="15" aria-hidden="true" />
          {{ copied ? 'Copied' : 'Copy' }}
        </button>
        <button type="button" class="focus-ring muted h-9 rounded-xl px-3 text-sm font-semibold hover:text-[var(--ink)]" @click="minted = null">
          Done
        </button>
      </div>
    </div>

    <form class="space-y-4" @submit.prevent="create">
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block">
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Name</span>
          <input v-model="form.name" required maxlength="80" placeholder="n8n production" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
          <span class="muted mt-1.5 block text-xs">For you, so you can tell them apart later.</span>
        </label>
        <label class="block">
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Shown in history as</span>
          <input v-model="form.agentLabel" maxlength="80" placeholder="Claude Desktop" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
          <span class="muted mt-1.5 block text-xs">Optional. Appears as “via …” on everything this token does.</span>
        </label>
      </div>

      <fieldset>
        <legend class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">What it may do</legend>
        <div class="space-y-1.5">
          <label v-for="(help, scope) in scopeHelp" :key="scope" class="flex cursor-pointer items-start gap-2.5 text-sm">
            <input type="checkbox" :checked="form.scopes.includes(scope)" class="focus-ring mt-0.5 size-4 rounded" @change="toggleScope(scope)">
            <span><strong class="font-semibold capitalize">{{ scope }}</strong> <span class="muted">— {{ help }}</span></span>
          </label>
        </div>
        <p class="muted mt-2 text-xs">
          A ceiling, not a grant: a token can never do more than you can. Giving it
          <strong class="font-semibold">write</strong> on a board where you are a viewer still leaves it a viewer.
        </p>
      </fieldset>

      <label v-if="boards.length" class="block">
        <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Limit to one board</span>
        <select v-model="form.boardId" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
          <option value="">Every board you can reach</option>
          <option v-for="board in boards" :key="board.id" :value="board.id">{{ board.name }}</option>
        </select>
      </label>

      <div class="flex justify-end">
        <button
          :disabled="creating || !form.name.trim() || !form.scopes.length"
          class="focus-ring flex h-10 items-center gap-1.5 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50"
        >
          <Plus :size="15" aria-hidden="true" /> {{ creating ? 'Creating…' : 'Create token' }}
        </button>
      </div>
    </form>

    <div v-if="!loading" class="border-t border-[var(--line)] pt-4">
      <ul v-if="live.length" class="space-y-2">
        <li v-for="token in live" :key="token.id" class="surface-strong flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-2.5 text-sm">
          <span class="font-semibold">{{ token.name }}</span>
          <span v-if="token.agentLabel" class="muted inline-flex items-center gap-1 text-xs">
            <Bot :size="13" aria-hidden="true" /> {{ token.agentLabel }}
          </span>
          <span class="muted font-mono text-xs">{{ token.scopes.join(' · ') }}</span>
          <span v-if="boardName(token.boardId)" class="muted text-xs">{{ boardName(token.boardId) }} only</span>
          <span class="muted ml-auto text-xs">
            {{ token.lastUsedAt ? `last used ${when(token.lastUsedAt)}` : 'never used' }}
          </span>
          <button type="button" class="focus-ring rounded-lg px-2 py-1 text-xs font-semibold text-rose-600 transition hover:bg-rose-500/10" @click="revoke(token)">
            Revoke
          </button>
        </li>
      </ul>
      <p v-else class="muted text-sm">No tokens yet. One is needed for the API, and for connecting an agent.</p>
    </div>
  </div>
</template>
