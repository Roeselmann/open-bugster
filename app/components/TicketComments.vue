<script setup lang="ts">
import { Check, MessageSquare, Pencil, Trash2, X } from '@lucide/vue'
import type { TicketComment } from '~~/shared/types/domain'

const props = defineProps<{ ticketId: string; canModerate?: boolean }>()
const emit = defineEmits<{ changed: []; notify: [type: 'success' | 'error', text: string] }>()

const { user } = useAuth()
const comments = ref<TicketComment[]>([])
const loading = ref(true)
const draft = ref('')
const posting = ref(false)
const editingId = ref('')
const editDraft = ref('')
const busyId = ref('')

const timeFormat = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

async function load() {
  loading.value = true
  try {
    const response = await $fetch<{ comments: TicketComment[] }>(`/api/tickets/${props.ticketId}/comments`)
    comments.value = response.comments
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    loading.value = false
  }
}

watch(() => props.ticketId, load, { immediate: true })

function mayEdit(comment: TicketComment) {
  return props.canModerate || (Boolean(comment.authorId) && comment.authorId === user.value?.id)
}

async function post() {
  const body = draft.value.trim()
  if (!body) return
  posting.value = true
  try {
    await $fetch(`/api/tickets/${props.ticketId}/comments`, { method: 'POST', body: { body } })
    draft.value = ''
    await load()
    emit('changed')
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    posting.value = false
  }
}

function startEdit(comment: TicketComment) {
  editingId.value = comment.id
  editDraft.value = comment.body
}

async function saveEdit(comment: TicketComment) {
  const body = editDraft.value.trim()
  if (!body) return
  busyId.value = comment.id
  try {
    await $fetch(`/api/comments/${comment.id}`, { method: 'PATCH', body: { body } })
    editingId.value = ''
    await load()
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    busyId.value = ''
  }
}

async function remove(comment: TicketComment) {
  busyId.value = comment.id
  try {
    await $fetch(`/api/comments/${comment.id}`, { method: 'DELETE' })
    await load()
    emit('changed')
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <section>
    <h3 class="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]">
      <MessageSquare :size="14" aria-hidden="true" /> Comments
      <span v-if="comments.length" class="muted font-semibold tabular-nums">{{ comments.length }}</span>
    </h3>

    <p v-if="loading" class="muted text-sm">Loading…</p>
    <p v-else-if="!comments.length" class="muted text-sm">No comments yet.</p>

    <ul v-else class="space-y-3">
      <li v-for="comment in comments" :key="comment.id" class="surface-strong rounded-xl px-3.5 py-3">
        <div class="flex items-center gap-2.5">
          <UiAvatar :person="comment.author" size="sm" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">
              {{ comment.author ? displayName(comment.author) : 'Unknown' }}
            </p>
            <p class="muted text-[11px]">
              {{ timeFormat.format(new Date(comment.createdAt)) }}
              <span v-if="comment.updatedAt !== comment.createdAt">· edited</span>
            </p>
          </div>
          <template v-if="mayEdit(comment) && editingId !== comment.id">
            <button type="button" class="focus-ring grid size-7 place-items-center rounded-lg text-[var(--muted)] transition hover:bg-[var(--panel)] hover:text-[var(--ink)]" :aria-label="`Edit comment by ${comment.author ? displayName(comment.author) : 'Unknown'}`" @click="startEdit(comment)">
              <Pencil :size="14" />
            </button>
            <button type="button" class="focus-ring grid size-7 place-items-center rounded-lg text-rose-600 transition hover:bg-rose-500/10" :disabled="busyId === comment.id" :aria-label="`Delete comment by ${comment.author ? displayName(comment.author) : 'Unknown'}`" @click="remove(comment)">
              <Trash2 :size="14" />
            </button>
          </template>
        </div>

        <div v-if="editingId === comment.id" class="mt-2.5">
          <textarea v-model="editDraft" rows="3" maxlength="10000" class="focus-ring surface w-full resize-y rounded-lg px-3 py-2 text-sm leading-relaxed outline-none" />
          <div class="mt-2 flex justify-end gap-2">
            <button type="button" class="focus-ring flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 text-xs font-semibold" @click="editingId = ''">
              <X :size="14" /> Cancel
            </button>
            <button type="button" :disabled="busyId === comment.id || !editDraft.trim()" class="focus-ring flex h-8 items-center gap-1.5 rounded-lg bg-[var(--ink)] px-2.5 text-xs font-semibold text-[var(--canvas)] disabled:opacity-50" @click="saveEdit(comment)">
              <Check :size="14" /> Save
            </button>
          </div>
        </div>
        <MarkdownView v-else :source="comment.body" class="mt-2 text-sm leading-relaxed" />
      </li>
    </ul>

    <div class="mt-3">
      <textarea
        v-model="draft"
        data-comment-input
        rows="3"
        maxlength="10000"
        class="focus-ring surface-strong w-full resize-y rounded-xl px-3.5 py-3 text-sm leading-relaxed outline-none"
        placeholder="Write a comment… Markdown is supported."
      />
      <div class="mt-2 flex justify-end">
        <button type="button" :disabled="posting || !draft.trim()" class="focus-ring h-9 rounded-xl bg-[var(--ink)] px-3.5 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50" @click="post">
          {{ posting ? 'Posting…' : 'Comment' }}
        </button>
      </div>
    </div>
  </section>
</template>
