<script setup lang="ts">
import { CircleCheck, CircleX, KeyRound, LoaderCircle, PlugZap, Save, Trash2, Upload } from '@lucide/vue'
import type { BoardSummary, TestFlightConnection } from '~~/shared/types/domain'

const props = defineProps<{ board: BoardSummary }>()
const emit = defineEmits<{ changed: []; notify: [type: 'success' | 'error', text: string] }>()

const form = reactive({ issuerId: '', keyId: '', appId: '', syncLimit: 100 })
const saving = ref(false)
const uploading = ref(false)
const removingKey = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: true; app: TestFlightConnection } | { ok: false; message: string } | null>(null)
const keyInput = ref<HTMLInputElement | null>(null)

watchEffect(() => {
  form.issuerId = props.board.credentials.issuerId
  form.keyId = props.board.credentials.keyId
  form.appId = props.board.credentials.appId
  form.syncLimit = props.board.syncLimit
})

// A stale "connected" badge next to edited credentials would be misleading.
watch(() => [form.issuerId, form.keyId, form.appId, props.board.credentials.keyUploadedAt], () => {
  testResult.value = null
})

// The test uses whatever stands in the form, so it only needs the .p8 to be in the vault.
const canTest = computed(() => Boolean(
  form.issuerId.trim() && form.keyId.trim() && form.appId.trim() && props.board.credentials.keyFilename
))

const unsaved = computed(() => {
  const saved = props.board.credentials
  return form.issuerId.trim() !== saved.issuerId
    || form.keyId.trim() !== saved.keyId
    || form.appId.trim() !== saved.appId
    || Number(form.syncLimit) !== props.board.syncLimit
})

const dateFormatter = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' })
const keyUploadedText = computed(() => {
  const value = props.board.credentials.keyUploadedAt
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date)
})

async function testConnection() {
  testing.value = true
  testResult.value = null
  try {
    const response = await $fetch<{ app: TestFlightConnection }>(`/api/boards/${props.board.id}/test-connection`, {
      method: 'POST',
      body: { issuerId: form.issuerId.trim(), keyId: form.keyId.trim(), appId: form.appId.trim() },
    })
    testResult.value = { ok: true, app: response.app }
  } catch (error) {
    testResult.value = { ok: false, message: errorText(error) }
  } finally {
    testing.value = false
  }
}

async function save() {
  saving.value = true
  try {
    await $fetch(`/api/boards/${props.board.id}`, { method: 'PATCH', body: { ...form, syncLimit: Number(form.syncLimit) } })
    emit('changed')
    emit('notify', 'success', 'TestFlight settings saved.')
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    saving.value = false
  }
}

async function uploadKey(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('key', file)
    await $fetch(`/api/boards/${props.board.id}/key`, { method: 'POST', body: formData })
    emit('changed')
    emit('notify', 'success', 'Private key stored.')
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    uploading.value = false
  }
}

async function removeKey() {
  removingKey.value = true
  try {
    await $fetch(`/api/boards/${props.board.id}/key`, { method: 'DELETE' })
    emit('changed')
    emit('notify', 'success', 'Private key removed.')
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    removingKey.value = false
  }
}
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">App Store Connect</p>
      <h2 class="mt-0.5 text-lg font-bold">TestFlight</h2>
      <p class="muted mt-1 text-sm">These credentials belong to this board alone, so every board can track its own app.</p>
    </header>

    <form class="space-y-4 px-5 py-5" @submit.prevent="save">
      <div class="grid gap-4 sm:grid-cols-3">
        <label class="block">
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Issuer ID</span>
          <input v-model="form.issuerId" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none" maxlength="120" placeholder="69a6de70-…">
        </label>
        <label class="block">
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Key ID</span>
          <input v-model="form.keyId" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none" maxlength="120" placeholder="ABC123DEFG">
        </label>
        <label class="block">
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">App ID</span>
          <input v-model="form.appId" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none" maxlength="120" placeholder="1234567890">
        </label>
      </div>

      <div>
        <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Private key (.p8)</span>
        <div class="surface-strong flex flex-wrap items-center gap-3 rounded-xl p-3.5">
          <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]"><KeyRound :size="16" /></span>
          <div class="min-w-0 flex-1">
            <p v-if="board.credentials.keyFilename" class="truncate text-sm font-semibold">{{ board.credentials.keyFilename }}</p>
            <p v-else class="text-sm font-semibold">No key stored</p>
            <p class="muted text-[11px]">
              <template v-if="board.credentials.keyFilename">Uploaded {{ keyUploadedText }} · stored encrypted, never shown again</template>
              <template v-else>Upload the .p8 exactly as downloaded from App Store Connect.</template>
            </p>
          </div>
          <input ref="keyInput" type="file" accept=".p8" class="sr-only" @change="uploadKey">
          <button type="button" :disabled="uploading" class="focus-ring flex h-10 items-center gap-2 rounded-xl border border-[var(--line)] px-3 text-sm font-semibold hover:bg-[var(--panel)] disabled:opacity-50" @click="keyInput?.click()">
            <Upload :size="16" /> {{ uploading ? 'Uploading…' : board.credentials.keyFilename ? 'Replace' : 'Upload' }}
          </button>
          <button
            v-if="board.credentials.keyFilename"
            type="button"
            :disabled="removingKey"
            class="focus-ring grid size-10 place-items-center rounded-xl text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
            aria-label="Remove private key"
            @click="removeKey"
          ><Trash2 :size="16" /></button>
        </div>
      </div>

      <label class="block max-w-xs">
        <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Submissions per sync</span>
        <input
          v-model.number="form.syncLimit"
          type="number"
          min="1"
          max="2000"
          step="1"
          class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none"
        >
        <span class="muted mt-2 block text-[11px] leading-relaxed">
          Each sync checks this many of the newest submissions per feedback type — screenshots and crashes counted separately — and imports the ones that are not on the board yet.
        </span>
      </label>

      <div class="flex flex-wrap items-center gap-3">
        <p v-if="board.credentials.complete" class="flex items-center gap-1.5 text-sm font-semibold text-emerald-600">
          <CircleCheck :size="16" /> Ready to sync
        </p>
        <p v-else class="muted text-sm">Fill in all three IDs and upload the .p8 to enable the TestFlight sync.</p>
        <button
          type="button"
          :disabled="testing || !canTest"
          class="focus-ring ml-auto flex h-10 items-center gap-2 rounded-xl border border-[var(--line)] px-3.5 text-sm font-semibold hover:bg-[var(--panel)] disabled:cursor-not-allowed disabled:opacity-50"
          :title="canTest ? 'Ask Apple whether the credentials above work — saved or not' : 'Fill in all three IDs and upload the .p8 first'"
          @click="testConnection"
        >
          <LoaderCircle v-if="testing" :size="16" class="animate-spin" aria-hidden="true" />
          <PlugZap v-else :size="16" aria-hidden="true" />
          {{ testing ? 'Testing…' : 'Test connection' }}
        </button>
        <button type="submit" :disabled="saving" class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] disabled:opacity-50">
          <Save :size="16" /> {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>

      <p v-if="unsaved" class="muted text-[11px]">
        Unsaved changes. “Test connection” checks the values above as they stand; “Save” stores them.
      </p>

      <p v-if="testResult" role="status" class="flex items-start gap-2 rounded-xl p-3 text-sm" :class="testResult.ok ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-700 dark:text-rose-400'">
        <component :is="testResult.ok ? CircleCheck : CircleX" :size="16" class="mt-0.5 shrink-0" aria-hidden="true" />
        <span v-if="testResult.ok">
          Connected to <strong>{{ testResult.app.name || 'this app' }}</strong><template v-if="testResult.app.bundleId"> ({{ testResult.app.bundleId }})</template>.
        </span>
        <span v-else>{{ testResult.message }}</span>
      </p>
    </form>
  </section>
</template>
