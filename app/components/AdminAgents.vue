<script setup lang="ts">
import { Bot, Pencil, Plug, ShieldCheck, Trash2 } from '@lucide/vue'
import type { AgentAccount, BoardRole } from '~~/shared/types/domain'
import type { AgentIcon } from '~~/shared/utils/agent-icons'

/**
 * Agents with an identity of their own. Unlike a token on somebody's profile, which acts as
 * that person, an agent here is a user in its own right: it is assigned tickets, writes
 * comments under its own name, and reaches only the boards it is made a member of. It has
 * no address and no password — the tokens minted for it are its only way in.
 */
const { notify } = useNotify()
const { boards } = useBoards()
const { workspaces } = useWorkspaces()
await loadWorkspaces()

const { data, refresh } = await useFetch<{ services: AgentAccount[] }>('/api/services')
const agents = computed(() => data.value?.services || [])

const boardRoleLabels: Record<BoardRole, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Administrator' }
const dateFormat = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' })

const form = reactive({ name: '', description: '', icon: 'bot' as AgentIcon | null })
const creating = ref(false)
const busyId = ref('')
/** The agent whose tokens and connection details are open below its row. */
const connectingId = ref('')
/** The agent whose access settings are open below its row. One panel at a time. */
const accessId = ref('')

function togglePanel(kind: 'tokens' | 'access', id: string) {
  const current = kind === 'tokens' ? connectingId : accessId
  const other = kind === 'tokens' ? accessId : connectingId
  current.value = current.value === id ? '' : id
  other.value = ''
}

/** The grants in one line, shown above the boards it was added to by hand. */
function reach(agent: AgentAccount): string | null {
  const { access } = agent
  if (access.mode === 'all') return `Every board · ${boardRoleLabels[access.role || 'viewer']}`
  if (access.mode === 'workspaces') {
    return access.workspaces.map(grant => `${grant.workspaceName} · ${boardRoleLabels[grant.role]}`).join(', ')
  }
  return null
}

async function accessSaved() {
  await refresh()
  accessId.value = ''
}
const editing = ref<{ id: string; name: string; description: string; icon: AgentIcon | null } | null>(null)
const removal = ref<AgentAccount | null>(null)
const removalPending = ref(false)

function usage(agent: AgentAccount): string {
  const tokens = agent.activeTokens === 1 ? '1 working token' : `${agent.activeTokens || 'No'} working tokens`
  const seen = agent.lastUsedAt ? `last active ${dateFormat.format(new Date(agent.lastUsedAt))}` : 'never connected'
  return `${agent.status === 'disabled' ? 'Disabled' : 'Active'} · ${tokens} · ${seen}`
}

async function createAgent() {
  if (!form.name.trim() || creating.value) return
  creating.value = true
  try {
    const { service } = await $fetch<{ service: AgentAccount }>('/api/services', { method: 'POST', body: { ...form } })
    form.name = ''
    form.description = ''
    form.icon = 'bot'
    await refresh()
    // The next thing anybody does with a new agent is give it a token, so open that straight away.
    connectingId.value = service.id
    notify('success', `${service.name} was created. Add it to a board and give it a token to connect.`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    creating.value = false
  }
}

async function saveEdit() {
  const pending = editing.value
  if (!pending || !pending.name.trim()) return
  busyId.value = pending.id
  try {
    await $fetch(`/api/services/${pending.id}`, { method: 'PATCH', body: { name: pending.name, description: pending.description, icon: pending.icon } })
    editing.value = null
    await refresh()
    notify('success', 'The agent was updated.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    busyId.value = ''
  }
}

async function toggleStatus(agent: AgentAccount) {
  busyId.value = agent.id
  try {
    await $fetch(`/api/services/${agent.id}`, { method: 'PATCH', body: { status: agent.status === 'disabled' ? 'active' : 'disabled' } })
    await refresh()
    notify('success', agent.status === 'disabled'
      ? `${agent.name} is active again, and its tokens work.`
      : `${agent.name} was disabled. None of its tokens work until it is enabled again.`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    busyId.value = ''
  }
}

async function confirmRemoval() {
  const agent = removal.value
  if (!agent) return
  removalPending.value = true
  try {
    await $fetch(`/api/services/${agent.id}`, { method: 'DELETE' })
    if (connectingId.value === agent.id) connectingId.value = ''
    removal.value = null
    await refresh()
    notify('success', `${agent.name} was deleted.`)
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    removalPending.value = false
  }
}
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Instance</p>
      <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><Bot :size="18" aria-hidden="true" /> Agents</h2>
      <p class="muted mt-1 text-sm">
        An agent with a user of its own: tickets can be assigned to it, and its comments carry its
        own name. It needs no email address, cannot sign in, and connects only through the tokens
        made for it here. Under Access it gets whole workspaces or every board; single boards are
        added under Board settings → Users, like anybody else.
        An agent that should act as you instead uses a token from your profile.
      </p>
    </header>

    <ul v-if="agents.length" class="divide-y divide-[var(--line)]">
      <li v-for="agent in agents" :key="agent.id" class="px-5 py-4">
        <div v-if="editing?.id === agent.id" class="space-y-3">
          <div class="grid gap-3 sm:grid-cols-[14rem_1fr]">
            <label class="block">
              <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Name</span>
              <input v-model="editing.name" required maxlength="80" class="focus-ring surface-strong h-10 w-full rounded-xl px-3 text-sm outline-none" @keydown.enter.prevent="saveEdit">
            </label>
            <label class="block">
              <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">What it does</span>
              <input v-model="editing.description" maxlength="500" class="focus-ring surface-strong h-10 w-full rounded-xl px-3 text-sm outline-none" @keydown.enter.prevent="saveEdit">
            </label>
          </div>
          <div>
            <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Icon</span>
            <AgentIconPicker v-model="editing.icon" :name="editing.name" />
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" class="focus-ring h-9 rounded-lg px-3 text-sm font-semibold transition hover:bg-[var(--panel-strong)]" @click="editing = null">Cancel</button>
            <button type="button" :disabled="busyId === agent.id || !editing.name.trim()" class="focus-ring h-9 rounded-lg bg-[var(--primary)] px-3.5 text-sm font-semibold text-[var(--primary-ink)] transition hover:opacity-85 disabled:opacity-50" @click="saveEdit">Save</button>
          </div>
        </div>

        <div v-else class="flex flex-wrap items-center gap-3">
          <UiAvatar :person="{ firstName: agent.name, lastName: '', email: null, isService: true, icon: agent.icon }" size="lg" :muted="agent.status !== 'active'" />
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 truncate text-sm font-semibold">
              {{ agent.name }}
              <span class="tone tone-neutral rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wide">Agent</span>
            </p>
            <p v-if="agent.description" class="muted truncate text-xs">{{ agent.description }}</p>
            <p class="muted mt-0.5 text-[11px]">{{ usage(agent) }}</p>
            <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span
                v-if="reach(agent)"
                class="tone tone-violet rounded-full px-2 py-0.5 text-[11px] font-semibold"
                :title="agent.access.mode === 'all' ? 'Every board of the instance, including new ones' : 'Every board of these workspaces, including new ones'"
              >
                {{ agent.access.mode === 'all' ? '' : 'Workspaces: ' }}{{ reach(agent) }}
              </span>
              <span
                v-for="membership in agent.boards"
                :key="membership.boardId"
                class="tone tone-neutral rounded-full px-2 py-0.5 text-[11px] font-semibold"
                :title="`${boardRoleLabels[membership.role]} on ${membership.boardName}`"
              >
                {{ membership.boardName }}
                <span class="font-normal opacity-70">· {{ boardRoleLabels[membership.role] }}</span>
              </span>
              <span v-if="!agent.boards.length && !reach(agent)" class="muted text-[11px]">On no board yet — it can see nothing until it is added to one or given access</span>
            </div>
          </div>

          <button
            type="button"
            class="focus-ring flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 text-xs font-semibold transition hover:bg-[var(--panel-strong)]"
            :class="accessId === agent.id ? 'bg-[var(--panel-strong)]' : ''"
            :aria-expanded="accessId === agent.id"
            @click="togglePanel('access', agent.id)"
          >
            <ShieldCheck :size="14" aria-hidden="true" /> Access
          </button>
          <button
            type="button"
            class="focus-ring flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 text-xs font-semibold transition hover:bg-[var(--panel-strong)]"
            :class="connectingId === agent.id ? 'bg-[var(--panel-strong)]' : ''"
            :aria-expanded="connectingId === agent.id"
            @click="togglePanel('tokens', agent.id)"
          >
            <Plug :size="14" aria-hidden="true" /> Tokens
          </button>
          <button
            type="button"
            class="focus-ring grid size-8 place-items-center rounded-lg transition hover:bg-[var(--panel-strong)]"
            :aria-label="`Edit ${agent.name}`"
            @click="editing = { id: agent.id, name: agent.name, description: agent.description, icon: agent.icon }"
          >
            <Pencil :size="15" />
          </button>
          <button
            type="button"
            class="focus-ring h-8 rounded-lg border border-[var(--line)] px-2.5 text-xs font-semibold transition hover:bg-[var(--panel-strong)]"
            :disabled="busyId === agent.id"
            @click="toggleStatus(agent)"
          >
            {{ agent.status === 'disabled' ? 'Enable' : 'Disable' }}
          </button>
          <button
            type="button"
            class="focus-ring grid size-8 place-items-center rounded-lg text-rose-600 transition hover:bg-rose-500/10"
            :aria-label="`Delete ${agent.name}`"
            @click="removal = agent"
          >
            <Trash2 :size="15" />
          </button>
        </div>

        <div v-if="accessId === agent.id" class="surface-strong mt-3 overflow-hidden rounded-xl">
          <AgentAccessEditor :agent="agent" :workspaces="workspaces" @saved="accessSaved" />
        </div>

        <div v-if="connectingId === agent.id" class="surface-strong mt-3 overflow-hidden rounded-xl">
          <p class="muted border-b border-[var(--line)] px-5 pt-4 pb-3 text-xs">
            Everything a token below does is recorded as {{ agent.name }}. Paste one into the agent’s
            MCP configuration, or use it with the API.
          </p>
          <ApiTokenManager :principal-id="agent.id" :holder-name="agent.name" :boards="boards" @changed="refresh" />
          <div class="border-t border-[var(--line)]">
            <McpConnection />
          </div>
        </div>
      </li>
    </ul>
    <p v-else class="muted px-5 py-4 text-sm">No agents yet.</p>

    <form class="flex flex-wrap items-end gap-3 border-t border-[var(--line)] px-5 py-4" @submit.prevent="createAgent">
      <label class="min-w-44 flex-1">
        <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Name</span>
        <input v-model="form.name" required maxlength="80" placeholder="Hermes" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
      </label>
      <label class="min-w-56 flex-[2]">
        <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">What it does</span>
        <input v-model="form.description" maxlength="500" placeholder="Optional — triages new bug reports" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
      </label>
      <button :disabled="creating || !form.name.trim()" class="focus-ring h-11 rounded-xl bg-[var(--primary)] px-4 text-sm font-semibold text-[var(--primary-ink)] transition hover:opacity-85 disabled:opacity-50">
        {{ creating ? 'Creating…' : 'Create agent' }}
      </button>
      <div class="basis-full">
        <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Icon</span>
        <AgentIconPicker v-model="form.icon" :name="form.name" />
      </div>
    </form>

    <UiConfirmDialog
      v-if="removal"
      :open="true"
      :title="`Delete ${removal.name}?`"
      description="The agent and every token made for it are deleted, so whatever uses those tokens stops working at once. Its tickets, comments and history stay on the boards but lose the name behind them — to keep it, disable the agent instead."
      confirm-label="Delete agent"
      :pending="removalPending"
      @update:open="open => !open && (removal = null)"
      @confirm="confirmRemoval"
    />
  </section>
</template>
