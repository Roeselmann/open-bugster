<script setup lang="ts">
import type { AgentAccessMode, AgentAccount, AgentGrantRole, WorkspaceSummary } from '~~/shared/types/domain'

/**
 * How far an agent reaches beyond the boards it was added to by hand. Explicit memberships
 * keep counting in every mode, and where both apply the higher role wins — so a single
 * board can still be handed out at a higher role than the rest of its workspace.
 */
const props = defineProps<{
  agent: AgentAccount
  workspaces: WorkspaceSummary[]
}>()
const emit = defineEmits<{ saved: [] }>()
const { notify } = useNotify()

const roleOptions = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
]
const modes: Array<{ value: AgentAccessMode; label: string; help: string }> = [
  { value: 'boards', label: 'Only the boards it is added to', help: 'Chosen board by board, under Board settings → Users.' },
  { value: 'workspaces', label: 'Selected workspaces', help: 'Every board in them, including boards created later.' },
  { value: 'all', label: 'All workspaces', help: 'Every board on this instance, including boards created later.' },
]

const mode = ref<AgentAccessMode>(props.agent.access.mode)
const allRole = ref<AgentGrantRole>(props.agent.access.role || 'viewer')
/** Workspace id → role; a workspace missing from the map is not granted. */
const picked = reactive<Record<string, AgentGrantRole>>(
  Object.fromEntries(props.agent.access.workspaces.map(grant => [grant.workspaceId, grant.role])))
const saving = ref(false)

function toggleWorkspace(id: string) {
  if (picked[id]) delete picked[id]
  else picked[id] = 'viewer'
}

const canSave = computed(() => mode.value !== 'workspaces' || Object.keys(picked).length > 0)

async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    await $fetch(`/api/services/${props.agent.id}/access`, {
      method: 'PUT',
      body: {
        mode: mode.value,
        role: mode.value === 'all' ? allRole.value : null,
        workspaces: mode.value === 'workspaces'
          ? Object.entries(picked).map(([workspaceId, role]) => ({ workspaceId, role }))
          : [],
      },
    })
    notify('success', `${props.agent.name}’s access was saved.`)
    emit('saved')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-4 px-5 py-4">
    <fieldset class="space-y-2">
      <legend class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Reaches</legend>
      <label v-for="option in modes" :key="option.value" class="flex cursor-pointer items-start gap-2.5 text-sm">
        <input v-model="mode" type="radio" :name="`access-${agent.id}`" :value="option.value" class="focus-ring mt-0.5 size-4">
        <span>
          <strong class="font-semibold">{{ option.label }}</strong>
          <span class="muted"> — {{ option.help }}</span>
        </span>
      </label>
    </fieldset>

    <div v-if="mode === 'all'" class="flex flex-wrap items-center gap-3">
      <span class="text-sm">Role on every board</span>
      <div class="w-36">
        <UiSelect v-model="allRole" :options="roleOptions" compact :aria-label="`Role of ${agent.name} on every board`" />
      </div>
    </div>

    <ul v-if="mode === 'workspaces'" class="divide-y divide-[var(--line)] rounded-xl border border-[var(--line)]">
      <li v-for="workspace in workspaces" :key="workspace.id" class="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
        <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm">
          <input type="checkbox" :checked="Boolean(picked[workspace.id])" class="focus-ring size-4 rounded" @change="toggleWorkspace(workspace.id)">
          <span class="truncate font-semibold">{{ workspace.name }}</span>
          <span class="muted shrink-0 text-xs">{{ workspace.boardCount === 1 ? '1 board' : `${workspace.boardCount} boards` }}</span>
        </label>
        <div class="w-32 shrink-0">
          <UiSelect
            :model-value="picked[workspace.id] || 'viewer'"
            :options="roleOptions"
            :disabled="!picked[workspace.id]"
            compact
            :aria-label="`Role of ${agent.name} in ${workspace.name}`"
            @update:model-value="value => (picked[workspace.id] = value as AgentGrantRole)"
          />
        </div>
      </li>
    </ul>

    <p class="muted text-xs">
      Boards it was added to by hand count in every mode, and the higher role wins. Administrator
      stays a per-board decision.
    </p>

    <div class="flex justify-end">
      <button
        type="button"
        :disabled="saving || !canSave"
        class="focus-ring h-9 rounded-lg bg-[var(--primary)] px-3.5 text-sm font-semibold text-[var(--primary-ink)] transition hover:opacity-85 disabled:opacity-50"
        @click="save"
      >
        {{ saving ? 'Saving…' : 'Save access' }}
      </button>
    </div>
  </div>
</template>
