<script setup lang="ts">
import { Trash2, UserPlus } from '@lucide/vue'
import type { BoardMember, BoardRole, BoardSummary, UserStatus } from '~~/shared/types/domain'

const props = defineProps<{ board: BoardSummary }>()
const emit = defineEmits<{ changed: []; notify: [type: 'success' | 'error', text: string] }>()

type Candidate = { id: string; email: string; firstName: string; lastName: string; status: UserStatus }

const canManage = computed(() => props.board.role === 'admin')
const members = computed(() => props.board.members)

const { user, instanceAdmin } = useAuth()

const boardRoleLabel: Record<BoardRole, string> = { viewer: 'a viewer', editor: 'an editor', admin: 'an administrator' }

/**
 * Where the viewer's own access actually comes from, spelled out. For an instance
 * administrator the membership rows below are not the grant, and saying so here is what
 * keeps their own row — present, demoted, or missing — from looking like a contradiction.
 */
const ownAccess = computed(() => {
  const ownRow = members.value.find(member => member.userId === user.value?.id)
  if (instanceAdmin.value) {
    const instanceRole = user.value?.role === 'owner' ? 'the instance owner' : 'an instance administrator'
    return ownRow
      ? `You are ${instanceRole}: you hold administrator access on this board regardless of your own row below.`
      : `You are ${instanceRole}: you hold administrator access on this board without being a member of it.`
  }
  return `You are ${boardRoleLabel[props.board.role]} of this board through your membership below.`
})

const roleOptions = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
  { value: 'admin', label: 'Administrator' },
]

const candidates = ref<Candidate[]>([])
const selectedCandidate = ref('')
const selectedRole = ref<BoardRole>('editor')
const busyId = ref('')
const adding = ref(false)

const candidateOptions = computed(() => candidates.value.map(candidate => ({
  value: candidate.id,
  label: `${displayName(candidate)} · ${candidate.email}`,
})))

async function loadCandidates() {
  if (!canManage.value) return
  try {
    const response = await $fetch<{ candidates: Candidate[] }>(`/api/boards/${props.board.id}/members/candidates`)
    candidates.value = response.candidates
    // A select never renders an empty value, so the picker always starts on a real account.
    if (!candidates.value.some(candidate => candidate.id === selectedCandidate.value)) {
      selectedCandidate.value = candidates.value[0]?.id || ''
    }
  } catch {
    candidates.value = []
  }
}

watch(() => [props.board.id, props.board.members.length], loadCandidates, { immediate: true })

async function addMember() {
  if (!selectedCandidate.value) return
  adding.value = true
  try {
    await $fetch(`/api/boards/${props.board.id}/members/${selectedCandidate.value}`, { method: 'PUT', body: { role: selectedRole.value } })
    emit('changed')
    emit('notify', 'success', 'The member was added.')
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    adding.value = false
  }
}

async function changeRole(member: BoardMember, role: BoardRole) {
  busyId.value = member.userId
  try {
    await $fetch(`/api/boards/${props.board.id}/members/${member.userId}`, { method: 'PUT', body: { role } })
    emit('changed')
    emit('notify', 'success', `${displayName(member)} is now ${role === 'admin' ? 'an administrator' : `${role === 'editor' ? 'an editor' : 'a viewer'}`}.`)
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    busyId.value = ''
  }
}

/**
 * The **Integration** box: whether this membership may be worked through a token.
 *
 * The role is sent along because it is a full membership write; the server keeps whatever it
 * is not told about, but saying both makes the request describe the membership it means.
 */
async function setAutomation(member: BoardMember, mayAutomate: boolean) {
  busyId.value = member.userId
  try {
    await $fetch(`/api/boards/${props.board.id}/members/${member.userId}`, {
      method: 'PUT',
      body: { role: member.role, mayAutomate },
    })
    emit('changed')
    emit('notify', 'success', mayAutomate
      ? `${displayName(member)} can now work this board through the API and agents.`
      : `${displayName(member)} can now only work this board in the browser.`)
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    busyId.value = ''
  }
}

async function removeMember(member: BoardMember) {
  busyId.value = member.userId
  try {
    await $fetch(`/api/boards/${props.board.id}/members/${member.userId}`, { method: 'DELETE' })
    emit('changed')
    emit('notify', 'success', `${displayName(member)} no longer has access to this board.`)
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Access</p>
      <h2 class="mt-0.5 text-lg font-bold">Members</h2>
      <p class="muted mt-1 text-sm">
        Viewers read and comment, editors work the board, administrators also change these settings
        and the App Store Connect key. Instance administrators always have access.
        <strong class="font-semibold">Integration</strong> is separate from the role: it says whether
        somebody may work this board through the API or an agent, at their own role and no further.
        Administrators always may.
      </p>
      <p class="mt-2 text-sm font-medium">{{ ownAccess }}</p>
    </header>

    <ul v-if="members.length" class="divide-y divide-[var(--line)]">
      <li v-for="member in members" :key="member.userId" class="flex flex-wrap items-center gap-3 px-5 py-3.5">
        <UiAvatar :person="member" :muted="member.status !== 'active'" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold">{{ displayName(member) }}</p>
          <p class="muted truncate text-xs">
            {{ member.email }}<span v-if="member.status === 'invited'"> · invitation pending</span>
          </p>
        </div>
        <!-- An administrator always holds it, so the box is ticked and left alone. -->
        <label
          class="flex shrink-0 items-center gap-2"
          :class="member.role === 'admin' ? 'cursor-default' : 'cursor-pointer'"
          :title="member.role === 'admin'
            ? 'A board administrator may always work this board through the API or an agent.'
            : `Whether ${displayName(member)} may work this board through the API or an agent`"
        >
          <input
            type="checkbox"
            :checked="member.mayAutomate"
            :disabled="!canManage || member.role === 'admin' || busyId === member.userId"
            class="focus-ring size-4 rounded"
            :class="member.role === 'admin' ? 'cursor-default' : 'disabled:opacity-40'"
            @change="setAutomation(member, !member.mayAutomate)"
          >
          <span class="muted text-[10px] font-bold uppercase tracking-[.08em]">Integration</span>
        </label>
        <div class="w-40 shrink-0">
          <UiSelect
            :model-value="member.role"
            :options="roleOptions"
            :disabled="!canManage || busyId === member.userId"
            compact
            :aria-label="`Role of ${displayName(member)} on this board`"
            @update:model-value="value => changeRole(member, value as BoardRole)"
          />
        </div>
        <button
          v-if="canManage"
          class="focus-ring grid size-8 place-items-center rounded-lg text-rose-600 transition hover:bg-rose-500/10 disabled:opacity-40"
          :disabled="busyId === member.userId"
          :aria-label="`Remove ${displayName(member)} from this board`"
          @click="removeMember(member)"
        >
          <Trash2 :size="15" />
        </button>
      </li>
    </ul>
    <p v-else class="muted px-5 py-6 text-sm">Nobody has been added to this board yet.</p>

    <form v-if="canManage" class="flex flex-wrap items-center gap-3 border-t border-[var(--line)] px-5 py-4" @submit.prevent="addMember">
      <div v-if="candidateOptions.length" class="min-w-56 flex-1">
        <UiSelect v-model="selectedCandidate" :options="candidateOptions" aria-label="Account to add to this board" />
      </div>
      <p v-else class="muted flex-1 text-sm">Every account already has access. New people are created under Users.</p>
      <div v-if="candidateOptions.length" class="w-40 shrink-0">
        <UiSelect v-model="selectedRole" :options="roleOptions" aria-label="Role for the new member" />
      </div>
      <button
        v-if="candidateOptions.length"
        :disabled="adding || !selectedCandidate"
        class="focus-ring flex h-11 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50"
      >
        <UserPlus :size="16" aria-hidden="true" /> {{ adding ? 'Adding…' : 'Add member' }}
      </button>
    </form>
  </section>
</template>
