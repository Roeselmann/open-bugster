<script setup lang="ts">
import { BookOpen } from '@lucide/vue'

/**
 * What a receiver is told, written for whoever is wiring up the other end.
 *
 * The events and the delivery rules come from the shared catalogue rather than being restated
 * here, so this page cannot describe a webhook the server does not send.
 */

type Tab = 'payload' | 'events' | 'signature' | 'delivery'
const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'payload', label: 'Payload' },
  { id: 'events', label: 'Events' },
  { id: 'signature', label: 'Signature' },
  { id: 'delivery', label: 'Delivery' },
]
const tab = ref<Tab>('payload')

/** Which sample body is shown. One per shape of `data`, not one per event. */
const sample = ref<'ticket' | 'comment' | 'run'>('ticket')

const envelope = {
  event: 'ticket.updated',
  at: '2026-08-29T10:12:04.221Z',
  boardId: 'brd_7cf2…',
  actor: { principalId: 'usr_a41c…', agentId: 'n8n prod', channel: 'api' },
  data: { '…': 'one key, named below' },
}

/**
 * A ticket exactly as it is sent: every field, including the ones most workflows ignore.
 * Shown filled in rather than as a type, because the question this answers is usually
 * "can I read X out of it" rather than "what is X's type".
 */
const ticketSample = {
  ticket: {
    id: 'tkt_9b1e…',
    ticketNumber: 412,
    boardId: 'brd_7cf2…',
    laneId: 'lane_triage',
    title: 'Crash when opening the gallery offline',
    description: 'Full body text, however long it is.',
    position: 3,
    priority: 'high',
    dueDate: '2026-09-04',
    buildNumber: '1.8.2 (441)',
    link: null,
    source: 'testflight',
    externalId: 'apple_fb_9f21…',
    createdAt: '2026-08-28T08:44:10.000Z',
    updatedAt: '2026-08-29T10:12:04.180Z',
    archivedAt: null,
    author: { id: 'usr_3d90…', email: 'tester@example.com', firstName: 'Ada', lastName: 'Lovelace', isAccount: false, isService: false, status: null, anonymizedAt: null },
    assignee: { id: 'usr_a41c…', email: 'dev@example.com', firstName: 'Grace', lastName: 'Hopper', isAccount: true, isService: false, status: 'active', anonymizedAt: null },
    commentCount: 2,
    category: { id: 'cat_crash', name: 'Crash', color: 'rose' },
    labels: [{ id: 'lbl_ios', name: 'iOS' }],
    feedback: {
      feedbackType: 'crash',
      comment: 'Happened right after airplane mode.',
      tester: { id: 'usr_3d90…', email: 'tester@example.com', firstName: 'Ada', lastName: 'Lovelace', isAccount: false, isService: false, status: null, anonymizedAt: null },
      deviceModel: 'iPhone 15 Pro',
      osVersion: '18.4',
      locale: 'en-GB',
      buildId: 'bld_22a…',
      buildVersion: '441',
      buildBundleId: 'com.example.app',
      sourceCreatedAt: '2026-08-28T08:40:02.000Z',
    },
    attachments: [{ id: 'att_1', kind: 'screenshot', filename: 'gallery.png', mimeType: 'image/png', size: 284119, url: '/api/attachments/att_1' }],
    todos: [{ id: 'td_1', text: 'Reproduce offline', completed: true, position: 0 }],
  },
}

const commentSample = {
  comment: {
    id: 'cmt_51aa…',
    ticketId: 'tkt_9b1e…',
    author: { id: 'usr_a41c…', email: 'dev@example.com', firstName: 'Grace', lastName: 'Hopper', isAccount: true, isService: false, status: 'active', anonymizedAt: null },
    authorId: 'usr_a41c…',
    body: 'The comment in full, as it was written.',
    createdAt: '2026-08-29T10:12:04.180Z',
    updatedAt: '2026-08-29T10:12:04.180Z',
  },
}

const runSample = {
  run: {
    id: 'run_0c72…',
    boardId: 'brd_7cf2…',
    startedAt: '2026-08-29T10:05:00.000Z',
    finishedAt: '2026-08-29T10:05:12.400Z',
    status: 'partial',
    importedCount: 7,
    skippedCount: 31,
    failedCount: 1,
    errorMessage: 'One attachment could not be downloaded.',
  },
}

const samples = { ticket: ticketSample, comment: commentSample, run: runSample }
const sampleLabels = { ticket: 'ticket.*', comment: 'comment.added', run: 'import.completed' } as const

const pretty = (value: unknown) => JSON.stringify(value, null, 2)

/** The catalogue writes field names in backticks; here they become inline code. */
const segments = (text: string) =>
  text.split(/`([^`]+)`/).map((piece, index) => ({ text: piece, code: index % 2 === 1 }))

const headers = [
  { name: 'Content-Type', value: 'application/json', note: 'Always. The body is UTF-8 JSON.' },
  { name: 'User-Agent', value: 'Open-Bugster-Webhook/1', note: 'Useful for a receiver that serves more than one sender.' },
  { name: 'X-Bugster-Event', value: 'ticket.updated', note: 'The same value as `event` in the body — enough to route on without parsing.' },
  { name: 'X-Bugster-Delivery', value: 'a UUID', note: 'New per attempt. A retry carries a different one, so deduplicate on the body, not on this.' },
  { name: 'X-Bugster-Signature', value: 't=<unix>,v1=<hex>', note: 'HMAC-SHA256 over `<t>.<raw body>` with the signing secret.' },
]

const verifySnippet = `import { createHmac, timingSafeEqual } from 'node:crypto'

// The raw body, before any JSON parsing — re-serialising changes the bytes and breaks the check.
function verify(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(',').map(piece => piece.split('=')))
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t))
  if (!Number.isFinite(Number(parts.t)) || age > ${WEBHOOK_DELIVERY.signatureToleranceSeconds}) return false

  const expected = createHmac('sha256', secret).update(\`\${parts.t}.\${rawBody}\`).digest()
  const actual = Buffer.from(parts.v1, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}`
</script>

<template>
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Automation</p>
      <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold">
        <BookOpen :size="18" aria-hidden="true" /> What a webhook sends
      </h2>
      <p class="muted mt-1 text-sm">
        For whoever is building the other end. Every delivery has the same envelope; only
        <code class="font-mono text-xs">data</code> differs per event.
      </p>
    </header>

    <div class="px-5 py-5">
      <div class="surface-strong flex flex-wrap gap-1 rounded-xl p-1" role="tablist" aria-label="Webhook reference">
        <button
          v-for="entry in tabs"
          :key="entry.id"
          type="button"
          role="tab"
          :aria-selected="tab === entry.id"
          class="focus-ring h-9 flex-1 basis-24 rounded-lg text-sm font-semibold transition"
          :class="tab === entry.id ? 'bg-[var(--ink)] text-[var(--canvas)]' : 'muted hover:text-[var(--ink)]'"
          @click="tab = entry.id"
        >
          {{ entry.label }}
        </button>
      </div>

      <!-- ── the envelope and the three shapes of `data` ─────────────────── -->
      <div v-if="tab === 'payload'" class="mt-5 space-y-5">
        <div>
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Every delivery</span>
          <pre class="surface-strong overflow-x-auto rounded-lg px-3 py-2.5 font-mono text-xs leading-relaxed">{{ pretty(envelope) }}</pre>
          <p class="muted mt-1.5 text-xs">
            <code class="font-mono">at</code> is when the event was raised, not when this attempt was made.
            <code class="font-mono">actor</code> is who answers for the change: <code class="font-mono">principalId</code>
            is the person or service identity, <code class="font-mono">agentId</code> the label of the token that acted
            (null when somebody did it directly), and <code class="font-mono">channel</code> is
            <code class="font-mono">web</code>, <code class="font-mono">api</code> or <code class="font-mono">mcp</code>.
          </p>
        </div>

        <div>
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-bold uppercase tracking-[.08em]">Inside <code class="font-mono normal-case">data</code></span>
            <div class="flex gap-1">
              <button
                v-for="(label, key) in sampleLabels"
                :key="key"
                type="button"
                class="focus-ring rounded-lg px-2 py-1 font-mono text-[11px] font-semibold transition"
                :class="sample === key ? 'bg-[var(--accent-soft)] text-[var(--ink)]' : 'muted hover:text-[var(--ink)]'"
                @click="sample = key"
              >
                {{ label }}
              </button>
            </div>
          </div>
          <pre class="surface-strong max-h-96 overflow-auto rounded-lg px-3 py-2.5 font-mono text-xs leading-relaxed">{{ pretty(samples[sample]) }}</pre>
          <p v-if="sample === 'ticket'" class="muted mt-1.5 text-xs">
            The whole ticket, every time — the same object the API returns from
            <code class="font-mono">GET /api/v1/tickets/&#123;ticketId&#125;</code>. On a ticket filed here rather than
            imported, <code class="font-mono">feedback</code> is null and <code class="font-mono">source</code> reads
            <code class="font-mono">manual</code>. Attachment URLs are paths on this instance and still need a token.
          </p>
          <p v-else-if="sample === 'comment'" class="muted mt-1.5 text-xs">
            <code class="font-mono">author</code> is null once that account has been hard-deleted, and its
            <code class="font-mono">email</code> is null once the person has been anonymized.
          </p>
          <p v-else class="muted mt-1.5 text-xs">
            <code class="font-mono">status</code> is <code class="font-mono">success</code>,
            <code class="font-mono">partial</code> or <code class="font-mono">failed</code>. A run that failed outright
            sends this too, so a workflow can notice a sync that stopped working.
          </p>
        </div>

        <div>
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Headers</span>
          <dl class="space-y-2">
            <div v-for="header in headers" :key="header.name" class="text-sm">
              <dt class="flex flex-wrap items-baseline gap-2">
                <code class="font-mono text-xs font-semibold">{{ header.name }}</code>
                <code class="muted font-mono text-[11px]">{{ header.value }}</code>
              </dt>
              <dd class="muted mt-0.5 text-xs leading-relaxed">
                <template v-for="(piece, index) in segments(header.note)" :key="index">
                  <code v-if="piece.code" class="font-mono">{{ piece.text }}</code><template v-else>{{ piece.text }}</template>
                </template>
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <!-- ── what fires, and what it carries ─────────────────────────────── -->
      <div v-else-if="tab === 'events'" class="mt-5 space-y-4">
        <div v-for="entry in WEBHOOK_EVENTS" :key="entry.event" class="border-b border-[var(--line)] pb-4 last:border-0 last:pb-0">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <code class="font-mono text-sm font-semibold">{{ entry.event }}</code>
            <span class="muted font-mono text-[11px]">data.{{ entry.dataKey }}</span>
          </div>
          <p class="muted mt-1 text-xs leading-relaxed">
            <template v-for="(piece, index) in segments(entry.fires)" :key="index">
              <code v-if="piece.code" class="font-mono">{{ piece.text }}</code><template v-else>{{ piece.text }}</template>
            </template>
          </p>
          <p class="mt-1 text-xs leading-relaxed">
            <template v-for="(piece, index) in segments(entry.holds)" :key="index">
              <code v-if="piece.code" class="font-mono">{{ piece.text }}</code><template v-else>{{ piece.text }}</template>
            </template>
          </p>
        </div>
        <p class="muted text-xs leading-relaxed">
          Only writes that succeeded are announced. A refused change — a bad payload, a missing
          permission — goes to the board’s audit trail and nowhere else. Nothing else on the board
          sends anything: lanes, labels, members, tokens and settings are silent.
        </p>
      </div>

      <!-- ── proving the delivery came from here ─────────────────────────── -->
      <div v-else-if="tab === 'signature'" class="mt-5 space-y-4">
        <p class="text-sm leading-relaxed">
          Every attempt carries <code class="font-mono text-xs">X-Bugster-Signature</code> as
          <code class="font-mono text-xs">t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>, where the hex is
          HMAC-SHA256 of <code class="font-mono text-xs">&lt;t&gt;.&lt;raw body&gt;</code> keyed with the signing
          secret shown once when the webhook was created. The timestamp is signed along with the body, so a captured
          delivery cannot be replayed later against a receiver that checks its age.
        </p>
        <pre class="surface-strong overflow-x-auto rounded-lg px-3 py-2.5 font-mono text-xs leading-relaxed">{{ verifySnippet }}</pre>
        <ul class="muted space-y-1.5 text-xs leading-relaxed">
          <li>Compare in constant time, and hash the bytes you received — not a re-serialised object.</li>
          <li>Reject anything older than {{ WEBHOOK_DELIVERY.signatureToleranceSeconds / 60 }} minutes; that is the window this instance assumes.</li>
          <li>The secret is shown once. Lost it? Remove the webhook and add it again — there is no way to read it back.</li>
        </ul>
      </div>

      <!-- ── what a receiver has to live with ────────────────────────────── -->
      <div v-else class="mt-5 space-y-4">
        <ul class="space-y-2 text-sm leading-relaxed">
          <li>
            <span class="font-semibold">Answer within {{ WEBHOOK_DELIVERY.requestTimeoutSeconds }} seconds.</span>
            <span class="muted"> Any 2xx counts as delivered; everything else, including a timeout, is a failed attempt.</span>
          </li>
          <li>
            <span class="font-semibold">{{ WEBHOOK_DELIVERY.maxAttempts }} attempts per event</span>
            <span class="muted">, backing off {{ WEBHOOK_DELIVERY.retryBaseSeconds }}s, 4s, 9s then 16s. Expect the same event twice — make the receiver idempotent.</span>
          </li>
          <li>
            <span class="font-semibold">No ordering.</span>
            <span class="muted"> Deliveries are fired without waiting on each other, so a retried event can arrive after a later one. Order by <code class="font-mono text-xs">at</code>, not by arrival.</span>
          </li>
          <li>
            <span class="font-semibold">{{ WEBHOOK_DELIVERY.failuresBeforeDisabling }} consecutive events that exhaust every attempt switch the webhook off.</span>
            <span class="muted"> It shows as switched off above; resuming it clears the count.</span>
          </li>
          <li>
            <span class="font-semibold">Attempts are kept for {{ WEBHOOK_DELIVERY.deliveryLogDays }} days</span>
            <span class="muted">, with the status, the error and how long it took — under “Attempts” above. They are a diagnostic, not a record.</span>
          </li>
        </ul>
        <p class="muted border-t border-[var(--line)] pt-3 text-xs leading-relaxed">
          A webhook exports more than the board view shows: full descriptions, whole comment bodies, and the
          email addresses of members, ticket authors and TestFlight testers all leave for the address you
          give here. There is no per-field filter — subscribing to an event means sending it whole. Point it
          at something you would be willing to hand the board’s contents to.
        </p>
      </div>
    </div>
  </section>
</template>
