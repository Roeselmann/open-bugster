<script setup lang="ts">
import { CircleCheck, CircleX, KeyRound, LoaderCircle, PlugZap, Save, Trash2 } from '@lucide/vue'
import type { BoardSummary, JiraConnection } from '~~/shared/types/domain'

const props = defineProps<{ board: BoardSummary }>()
const emit = defineEmits<{ changed: []; notify: [type: 'success' | 'error', text: string] }>()

// reka-ui refuses an empty select value, so "no type" needs a sentinel no uuid can collide with.
const NO_TYPE = 'none'
/** What a board starts with: the token owner's own open issues. */
const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
const form = reactive({ siteUrl: '', email: '', jql: '', syncLimit: 100, autoAuthor: true, importTypeId: NO_TYPE })
const tokenDraft = ref('')

const saving = ref(false)
const storingToken = ref(false)
const removingToken = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: true; connection: JiraConnection } | { ok: false; message: string } | null>(null)

// Reloaded from the board only when a saved value changes. Storing the token refreshes the
// board too, and must not throw away a site or query typed but not yet saved.
watch(
  () => [props.board.jira.siteUrl, props.board.jira.email, props.board.jira.jql, props.board.syncLimit, props.board.autoAuthor, props.board.importTypeId] as const,
  ([siteUrl, email, jql, syncLimit, autoAuthor, importTypeId]) => {
    form.siteUrl = siteUrl
    form.email = email
    form.jql = jql || DEFAULT_JQL
    form.syncLimit = syncLimit
    form.autoAuthor = autoAuthor
    form.importTypeId = importTypeId || NO_TYPE
  },
  { immediate: true }
)

// A stale "connected" badge next to edited credentials would be misleading.
watch(() => [form.siteUrl, form.email, form.jql, props.board.jira.tokenUpdatedAt], () => {
  testResult.value = null
})

// The test uses whatever stands in the form, so it only needs the token to be in the vault.
const canTest = computed(() => Boolean(form.siteUrl.trim() && form.email.trim() && props.board.jira.tokenLabel))

const unsaved = computed(() => {
  const saved = props.board.jira
  return form.siteUrl.trim() !== saved.siteUrl
    || form.email.trim() !== saved.email
    || form.jql.trim() !== saved.jql
    || Number(form.syncLimit) !== props.board.syncLimit
    || form.autoAuthor !== props.board.autoAuthor
    || (form.importTypeId === NO_TYPE ? null : form.importTypeId) !== props.board.importTypeId
})

const dateFormatter = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' })
const tokenStoredText = computed(() => {
  const value = props.board.jira.tokenUpdatedAt
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date)
})

async function testConnection() {
  testing.value = true
  testResult.value = null
  try {
    const response = await $fetch<{ connection: JiraConnection }>(`/api/boards/${props.board.id}/jira/test-connection`, {
      method: 'POST',
      body: { siteUrl: form.siteUrl.trim(), email: form.email.trim(), jql: form.jql.trim() },
    })
    testResult.value = { ok: true, connection: response.connection }
  } catch (error) {
    testResult.value = { ok: false, message: errorText(error) }
  } finally {
    testing.value = false
  }
}

async function save() {
  saving.value = true
  try {
    await $fetch(`/api/boards/${props.board.id}`, {
      method: 'PATCH',
      body: {
        jira: { siteUrl: form.siteUrl.trim(), email: form.email.trim(), jql: form.jql.trim() },
        syncLimit: Number(form.syncLimit),
        autoAuthor: form.autoAuthor,
        importTypeId: form.importTypeId === NO_TYPE ? null : form.importTypeId,
      },
    })
    emit('changed')
    emit('notify', 'success', 'Jira settings saved.')
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    saving.value = false
  }
}

async function storeToken() {
  const token = tokenDraft.value.trim()
  if (!token) return
  storingToken.value = true
  try {
    await $fetch(`/api/boards/${props.board.id}/jira/token`, { method: 'POST', body: { token } })
    tokenDraft.value = ''
    emit('changed')
    emit('notify', 'success', 'API token stored.')
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    storingToken.value = false
  }
}

async function removeToken() {
  removingToken.value = true
  try {
    await $fetch(`/api/boards/${props.board.id}/jira/token`, { method: 'DELETE' })
    emit('changed')
    emit('notify', 'success', 'API token removed.')
  } catch (error) {
    emit('notify', 'error', errorText(error))
  } finally {
    removingToken.value = false
  }
}
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Atlassian</p>
      <h2 class="mt-0.5 text-lg font-bold">Jira</h2>
      <p class="muted mt-1 text-sm">Issues matching the query below are imported once and then carried on here. Nothing is written back to Jira.</p>
    </header>

    <form class="space-y-4 px-5 py-5" @submit.prevent="save">
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block">
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Jira site</span>
          <input v-model="form.siteUrl" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none" maxlength="200" placeholder="https://your-team.atlassian.net" inputmode="url">
        </label>
        <label class="block">
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Atlassian account email</span>
          <input v-model="form.email" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none" maxlength="200" placeholder="you@example.com" inputmode="email" autocomplete="off">
        </label>
      </div>

      <div>
        <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">API token</span>
        <div class="surface-strong flex flex-wrap items-center gap-3 rounded-xl p-3.5">
          <span class="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]"><KeyRound :size="16" /></span>
          <div class="min-w-0 flex-1">
            <p v-if="board.jira.tokenLabel" class="truncate text-sm font-semibold">{{ board.jira.tokenLabel }}</p>
            <p v-else class="text-sm font-semibold">No token stored</p>
            <p class="muted text-[11px]">
              <template v-if="board.jira.tokenLabel">Stored {{ tokenStoredText }} · encrypted, never shown again. Atlassian tokens expire after at most a year.</template>
              <template v-else>Create one under <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer" class="underline decoration-dotted">Atlassian account → Security → API tokens</a>. It inherits the account's permissions.</template>
            </p>
          </div>
          <button
            v-if="board.jira.tokenLabel"
            type="button"
            :disabled="removingToken"
            class="focus-ring grid size-10 place-items-center rounded-xl text-rose-600 hover:bg-rose-500/10 disabled:opacity-40"
            aria-label="Remove API token"
            @click="removeToken"
          ><Trash2 :size="16" /></button>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <input
            v-model="tokenDraft"
            type="password"
            class="focus-ring surface-strong h-11 min-w-0 flex-1 rounded-xl px-3 text-sm outline-none"
            :placeholder="board.jira.tokenLabel ? 'Paste a new token to replace the stored one' : 'Paste the API token'"
            autocomplete="off"
            spellcheck="false"
            maxlength="1024"
            aria-label="API token"
            @keydown.enter.prevent="storeToken"
          >
          <button type="button" :disabled="storingToken || !tokenDraft.trim()" class="focus-ring flex h-11 items-center gap-2 rounded-xl border border-[var(--line)] px-3 text-sm font-semibold hover:bg-[var(--panel)] disabled:opacity-50" @click="storeToken">
            <KeyRound :size="16" /> {{ storingToken ? 'Storing…' : board.jira.tokenLabel ? 'Replace token' : 'Store token' }}
          </button>
        </div>
      </div>

      <label class="block">
        <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Issues to import (JQL)</span>
        <textarea
          v-model="form.jql"
          rows="3"
          maxlength="2000"
          class="focus-ring surface-strong w-full resize-y rounded-xl px-3 py-2.5 font-mono text-sm outline-none"
          spellcheck="false"
          :placeholder="DEFAULT_JQL"
        />
        <span class="muted mt-2 block text-[11px] leading-relaxed">
          Sent to Jira exactly as written. A sync takes the first results, up to “Items per sync”, and skips issues already on the board — so put an <code>ORDER BY</code> at the end and narrow the query yourself.
        </span>
      </label>

      <JqlHelp @use="form.jql = $event" />

      <BoardImportOptions
        v-model:sync-limit="form.syncLimit"
        v-model:auto-author="form.autoAuthor"
        v-model:import-type-id="form.importTypeId"
        :board-id="board.id"
      />

      <div class="flex flex-wrap items-center gap-3">
        <p v-if="board.jira.complete" class="flex items-center gap-1.5 text-sm font-semibold text-emerald-600">
          <CircleCheck :size="16" /> Ready to sync
        </p>
        <p v-else class="muted text-sm">Fill in the site, the email and the JQL, and store a token to enable the Jira sync.</p>
        <button
          type="button"
          :disabled="testing || !canTest"
          class="focus-ring ml-auto flex h-10 items-center gap-2 rounded-xl border border-[var(--line)] px-3.5 text-sm font-semibold hover:bg-[var(--panel)] disabled:cursor-not-allowed disabled:opacity-50"
          :title="canTest ? 'Ask Jira whether the values above work — saved or not' : 'Fill in the site and the email and store a token first'"
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
          Connected as <strong>{{ testResult.connection.displayName || 'this account' }}</strong><template v-if="testResult.connection.email"> ({{ testResult.connection.email }})</template>.
          <template v-if="testResult.connection.matchingIssues !== null"> The query currently matches {{ testResult.connection.matchingIssues }} {{ testResult.connection.matchingIssues === 1 ? 'issue' : 'issues' }}.</template>
        </span>
        <span v-else>{{ testResult.message }}</span>
      </p>
    </form>
  </section>
</template>
