<script setup lang="ts">
import { Check, Pencil, Tag, Trash2, X } from '@lucide/vue'
import type { CategoryColor, CategorySummary } from '~~/shared/types/domain'
import { categoryColors } from '~~/shared/types/domain'
import { CATEGORY_COLOR_LABELS, CATEGORY_TONE_CLASSES } from '~~/shared/utils/constants'

defineProps<{ categories: CategorySummary[] }>()
const emit = defineEmits<{ changed: []; notify: [type: 'success' | 'error', text: string] }>()

const toneOptions = categoryColors.map(color => ({
  value: color,
  label: CATEGORY_COLOR_LABELS[color],
  toneClass: CATEGORY_TONE_CLASSES[color],
}))

const busyId = ref<string | null>(null)
const editingId = ref<string | null>(null)
const draftName = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

const doomed = ref<CategorySummary | null>(null)
const deleting = ref(false)

function errorText(error: any) {
  return error?.data?.statusMessage || error?.statusMessage || 'Something went wrong.'
}

function startEdit(category: CategorySummary) {
  editingId.value = category.id
  draftName.value = category.name
  nextTick(() => nameInput.value?.select())
}

function cancelEdit() {
  // Clearing the id first makes the blur that follows a no-op.
  editingId.value = null
  draftName.value = ''
}

async function saveEdit(category: CategorySummary) {
  if (editingId.value !== category.id) return
  const name = draftName.value.trim()
  editingId.value = null
  if (!name || name === category.name) return
  await patchCategory(category, { name }, `Category renamed to “${name}”.`)
}

async function patchCategory(category: CategorySummary, body: { name?: string; color?: CategoryColor }, success?: string) {
  busyId.value = category.id
  try {
    await $fetch(`/api/categories/${category.id}`, { method: 'PATCH', body })
    emit('changed')
    if (success) emit('notify', 'success', success)
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    busyId.value = null
  }
}

async function confirmDelete() {
  const category = doomed.value
  if (!category || deleting.value) return
  deleting.value = true
  try {
    await $fetch(`/api/categories/${category.id}`, { method: 'DELETE' })
    doomed.value = null
    emit('changed')
    emit('notify', 'success', `Category “${category.name}” deleted.`)
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    deleting.value = false
  }
}

const deleteDescription = computed(() => {
  const count = doomed.value?.ticketCount || 0
  return count === 1 ? '1 ticket will lose this assignment.' : `${count} tickets will lose this assignment.`
})
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <h2 class="mt-0.5 text-lg font-bold">Categories</h2>
      <p class="muted mt-1 text-sm">Categories belong to this board. New ones are created from within a ticket — here they get their name and their colour.</p>
    </header>

    <ul v-if="categories.length" class="divide-y divide-[var(--line)]">
      <li v-for="category in categories" :key="category.id" class="flex flex-wrap items-center gap-3 px-5 py-3">
        <span class="grid size-8 shrink-0 place-items-center rounded-lg" :class="CATEGORY_TONE_CLASSES[category.color]"><Tag :size="15" /></span>

        <div class="min-w-0 flex-1">
          <template v-if="editingId === category.id">
            <input
              :ref="element => (nameInput = element as HTMLInputElement | null)"
              v-model="draftName"
              class="focus-ring surface-strong h-9 w-full min-w-0 rounded-xl px-3 text-sm font-semibold outline-none"
              maxlength="30"
              :aria-label="`Name of category ${category.name}`"
              @keydown.enter.prevent="saveEdit(category)"
              @keydown.esc.prevent="cancelEdit"
              @blur="saveEdit(category)"
            >
          </template>
          <template v-else>
            <p class="truncate text-sm font-semibold">{{ category.name }}</p>
            <p class="muted text-[11px]">{{ category.ticketCount }} {{ category.ticketCount === 1 ? 'ticket' : 'tickets' }}</p>
          </template>
        </div>

        <div class="w-36 shrink-0">
          <UiToneSelect
            :model-value="category.color"
            :options="toneOptions"
            :disabled="busyId === category.id"
            compact
            :aria-label="`Colour of category ${category.name}`"
            @update:model-value="value => patchCategory(category, { color: value as CategoryColor })"
          />
        </div>

        <div class="flex shrink-0 items-center gap-1">
          <button
            v-if="editingId === category.id"
            type="button"
            class="focus-ring grid size-9 place-items-center rounded-xl text-emerald-600 hover:bg-emerald-500/10"
            :aria-label="`Save name of ${category.name}`"
            @mousedown.prevent
            @click="saveEdit(category)"
          ><Check :size="16" /></button>
          <button
            v-if="editingId === category.id"
            type="button"
            class="focus-ring muted grid size-9 place-items-center rounded-xl hover:bg-[var(--panel-strong)]"
            :aria-label="`Discard the new name of ${category.name}`"
            @mousedown.prevent
            @click="cancelEdit"
          ><X :size="16" /></button>
          <button
            v-else
            type="button"
            class="focus-ring muted grid size-9 place-items-center rounded-xl hover:bg-[var(--panel-strong)] hover:text-[var(--ink)] disabled:opacity-40"
            :disabled="busyId === category.id"
            :aria-label="`Rename ${category.name}`"
            @click="startEdit(category)"
          ><Pencil :size="16" /></button>
          <button
            type="button"
            class="focus-ring grid size-9 place-items-center rounded-xl text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
            :disabled="busyId === category.id"
            :aria-label="`Delete ${category.name}`"
            @click="doomed = category"
          ><Trash2 :size="16" /></button>
        </div>
      </li>
    </ul>
    <p v-else class="muted px-5 py-6 text-sm">No categories yet. Create the first one in a ticket.</p>

    <UiConfirmDialog
      v-if="doomed"
      :open="true"
      :title="`Delete category “${doomed.name}”?`"
      :description="deleteDescription"
      confirm-label="Delete category"
      :pending="deleting"
      @update:open="open => !open && !deleting && (doomed = null)"
      @confirm="confirmDelete"
    />
  </section>
</template>
