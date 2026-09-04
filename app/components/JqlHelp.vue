<script setup lang="ts">
import { BookOpen, ChevronDown, CircleHelp, ExternalLink } from '@lucide/vue'

/**
 * A short guide to JQL beside the query field: how a query is built, where the full
 * reference lives, and the queries a board usually wants — each a click away from the field.
 * The sync sends the query exactly as written, so the guide is where the narrowing and the
 * ordering are explained rather than done behind the user's back.
 */
const emit = defineEmits<{ use: [jql: string] }>()

const open = ref(false)

const REFERENCE = 'https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/'
const FIELDS = 'https://support.atlassian.com/jira-software-cloud/docs/jql-fields/'
const FUNCTIONS = 'https://support.atlassian.com/jira-software-cloud/docs/jql-functions/'

const examples = [
  { title: 'My open issues', jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
  { title: 'Open bugs of one project', jql: 'project = APP AND issuetype = Bug AND statusCategory != Done ORDER BY created DESC' },
  { title: 'Everything reported by me', jql: 'reporter = currentUser() ORDER BY created DESC' },
  { title: 'Created in the last 30 days', jql: 'project = APP AND created >= -30d ORDER BY created DESC' },
  { title: 'Changed since a date', jql: 'project = APP AND updated >= "2026-01-01" ORDER BY updated DESC' },
  { title: 'The current sprint', jql: 'project = APP AND sprint in openSprints() ORDER BY rank' },
  { title: 'A label, still open', jql: 'labels = ios AND statusCategory != Done ORDER BY updated DESC' },
  { title: 'Unassigned and urgent', jql: 'project = APP AND assignee is EMPTY AND priority in (Highest, High) ORDER BY priority DESC' }
]
</script>

<template>
  <div class="surface-strong rounded-xl">
    <button
      type="button"
      class="focus-ring flex w-full items-center gap-2 rounded-xl px-3.5 py-3 text-left text-sm font-semibold hover:bg-[var(--panel)]"
      :aria-expanded="open"
      aria-controls="jql-help"
      @click="open = !open"
    >
      <CircleHelp :size="16" class="shrink-0 text-[var(--accent)]" aria-hidden="true" />
      <span class="flex-1">How to write the query</span>
      <ChevronDown :size="16" class="shrink-0 transition-transform" :class="open ? 'rotate-180' : ''" aria-hidden="true" />
    </button>

    <div v-show="open" id="jql-help" class="space-y-5 border-t border-[var(--line)] px-3.5 py-4 text-sm">
      <section class="space-y-2">
        <h3 class="text-xs font-bold uppercase tracking-[.08em]">In short</h3>
        <ul class="muted list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed">
          <li>A query is <code>field operator value</code>, joined with <code>AND</code> and <code>OR</code>: <code>project = APP AND issuetype = Bug</code>. Brackets group, <code>NOT</code> negates.</li>
          <li><code>statusCategory != Done</code> means “still open” in every workflow; <code>status = "In Progress"</code> names one column. Values with spaces go in quotes.</li>
          <li><code>currentUser()</code> is the account the token belongs to. Dates take <code>"2026-01-01"</code> or relative forms such as <code>-30d</code>, <code>-2w</code>, <code>startOfMonth()</code>.</li>
          <li>The sync sends the query exactly as written and takes the first results Jira returns, up to “Items per sync”. End it with <code>ORDER BY created DESC</code> or <code>ORDER BY updated DESC</code> so the newest come first.</li>
          <li>Issues already on the board are skipped, so a query may safely match more than it needs to. Narrow it with a project or a date to keep the count small.</li>
        </ul>
      </section>

      <section class="space-y-2">
        <h3 class="text-xs font-bold uppercase tracking-[.08em]">Common queries</h3>
        <ul class="space-y-1.5">
          <li v-for="example in examples" :key="example.jql" class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              class="focus-ring shrink-0 rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--panel)]"
              :title="`Put this query into the field: ${example.jql}`"
              @click="emit('use', example.jql)"
            >Use</button>
            <span class="text-[13px] font-semibold">{{ example.title }}</span>
            <code class="muted min-w-0 basis-full break-all text-[12px] sm:basis-auto sm:flex-1">{{ example.jql }}</code>
          </li>
        </ul>
      </section>

      <section class="space-y-2">
        <h3 class="text-xs font-bold uppercase tracking-[.08em]">Reference</h3>
        <ul class="space-y-1.5 text-[13px]">
          <li><a :href="REFERENCE" target="_blank" rel="noopener noreferrer" class="focus-ring inline-flex items-center gap-1.5 rounded font-semibold underline decoration-dotted hover:text-[var(--accent)]"><BookOpen :size="14" aria-hidden="true" /> JQL guide by Atlassian <ExternalLink :size="12" aria-hidden="true" /></a></li>
          <li><a :href="FIELDS" target="_blank" rel="noopener noreferrer" class="focus-ring inline-flex items-center gap-1.5 rounded font-semibold underline decoration-dotted hover:text-[var(--accent)]">All fields <ExternalLink :size="12" aria-hidden="true" /></a> <span class="muted">·</span> <a :href="FUNCTIONS" target="_blank" rel="noopener noreferrer" class="focus-ring inline-flex items-center gap-1.5 rounded font-semibold underline decoration-dotted hover:text-[var(--accent)]">All functions <ExternalLink :size="12" aria-hidden="true" /></a></li>
          <li class="muted">Try a query in Jira first: Filters → View all issues → switch to JQL. What works there works here, and “Test connection” reports how many issues it matches.</li>
        </ul>
      </section>
    </div>
  </div>
</template>
