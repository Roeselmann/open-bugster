<script setup lang="ts">
import { Check, Lock, PenLine, Plus, RotateCcw, Vote, X } from '@lucide/vue'
import type { Person, TicketDecisionInput } from '~~/shared/types/domain'

/**
 * A decision in the to-do list: a question with answers to pick from, one or several, maybe
 * one typed in. Three modes: setting it up (question, answers, how many may be picked) until
 * "Done"; answering it, where "Decide" settles it with what is picked and the editor's save
 * stamps who and when; and decided, showing its result. "Edit" goes back to setting it up.
 */
const props = defineProps<{
  question: string
  decision: TicketDecisionInput
  decided: boolean
  decidedBy?: Pick<Person, 'firstName' | 'lastName' | 'email'> | null
  decidedAt?: string | null
  canEdit: boolean
  /** In a strict list, the open step above that has to be done first. */
  blockedBy?: string | null
  inputKey: string
}>()

const emit = defineEmits<{
  'update:question': [value: string]
  /** The list changed and should be saved. */
  commit: []
  decide: []
  reopen: []
}>()

const dateFormat = new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' })
const editable = computed(() => props.canEdit && !props.decided)
// A new one, still without its question, opens set up for writing; a saved one for answering.
const editing = ref(props.canEdit && !props.decided && !props.question.trim())
const canFinish = computed(() => Boolean(props.question.trim()) && props.decision.options.some(option => option.trim()))

function startEditing() {
  editing.value = true
  nextTick(() => document.querySelector<HTMLInputElement>(`[data-todo-input="${props.inputKey}"]`)?.focus())
}

// Blank answers go once the setup is done, the picks following the ones that stay.
function finishEditing() {
  if (!canFinish.value) return
  const decision = props.decision
  const kept: number[] = []
  const options: string[] = []
  decision.options.forEach((option, index) => {
    if (!option.trim()) return
    kept[index] = options.length
    options.push(option.trim())
  })
  decision.chosen = decision.chosen.map(index => kept[index]).filter((index): index is number => index !== undefined)
  decision.options = options
  editing.value = false
  emit('commit')
}
const picked = computed(() => props.decision.chosen.length + (props.decision.other?.trim() ? 1 : 0))
const canDecide = computed(() => Boolean(props.question.trim()) && props.decision.options.some(option => option.trim()) && picked.value > 0)

function isChosen(index: number) {
  return props.decision.chosen.includes(index)
}

function toggle(index: number) {
  if (!editable.value || editing.value) return
  const decision = props.decision
  if (decision.multiple) {
    decision.chosen = isChosen(index) ? decision.chosen.filter(item => item !== index) : [...decision.chosen, index].sort((a, b) => a - b)
  } else {
    decision.chosen = isChosen(index) ? [] : [index]
    decision.other = null
  }
  emit('commit')
}

// The typed answer counts as picked once there is text; in a single choice it replaces the pick.
function typeOther(value: string) {
  props.decision.other = value || null
  if (value && !props.decision.multiple) props.decision.chosen = []
}

function setMultiple(multiple: boolean) {
  const decision = props.decision
  if (decision.multiple === multiple) return
  decision.multiple = multiple
  if (!multiple) {
    // One answer is left: the first picked, else the typed one.
    if (decision.chosen.length) {
      decision.chosen = decision.chosen.slice(0, 1)
      decision.other = null
    }
  }
  emit('commit')
}

function setAllowOther(allow: boolean) {
  props.decision.allowOther = allow
  if (!allow) props.decision.other = null
  emit('commit')
}

function focusOption(index: number) {
  nextTick(() => document.querySelector<HTMLInputElement>(`[data-decision-option="${props.inputKey}-${index}"]`)?.focus())
}

function addOption() {
  if (props.decision.options.length >= 20) return
  props.decision.options.push('')
  focusOption(props.decision.options.length - 1)
}

function removeOption(index: number) {
  const decision = props.decision
  decision.options.splice(index, 1)
  decision.chosen = decision.chosen.filter(item => item !== index).map(item => (item > index ? item - 1 : item))
  emit('commit')
}

function answerLabel(index: number) {
  return props.decision.options[index]?.trim() || `Option ${index + 1}`
}
</script>

<template>
  <div class="min-w-0 flex-1 py-1" data-decision>
    <div class="flex items-center gap-2">
      <span class="grid size-4 shrink-0 place-items-center" :class="decided ? 'text-[var(--accent)]' : 'muted'" :title="decided ? 'Decided' : 'Open decision'">
        <Vote :size="16" aria-hidden="true" />
      </span>
      <input
        v-if="editing"
        :value="question"
        :data-todo-input="inputKey"
        maxlength="500"
        class="focus-ring min-w-0 flex-1 bg-transparent px-1 py-1 text-sm font-semibold outline-none"
        placeholder="What needs to be decided?"
        aria-label="Question"
        @input="emit('update:question', ($event.target as HTMLInputElement).value)"
        @keydown.enter.prevent="focusOption(0)"
        @blur="emit('commit')"
      >
      <span v-else class="min-w-0 flex-1 px-1 py-1 text-sm font-semibold">{{ question }}</span>
      <button
        v-if="editable && !editing"
        type="button"
        class="focus-ring muted flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-semibold hover:bg-[var(--panel)] hover:text-[var(--ink)]"
        title="Change the question and its answers"
        @click="startEditing"
      ><PenLine :size="12" /> Edit</button>
      <span class="muted shrink-0 rounded-md bg-[var(--panel)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.06em]">
        {{ decision.multiple ? 'Multiple choice' : 'Single choice' }}
      </span>
    </div>

    <!-- Open: the answers to pick from, and the way to settle it. -->
    <template v-if="!decided">
      <div class="mt-2 space-y-1 pl-6" :role="decision.multiple ? 'group' : 'radiogroup'" :aria-label="question || 'Answers'">
        <!-- Setting up: the answers as text, the marker only saying single or multiple. -->
        <template v-if="editing">
          <div v-for="(option, index) in decision.options" :key="index" class="group/option flex items-center gap-2">
            <span class="size-4 shrink-0 border border-[var(--line)]" :class="decision.multiple ? 'rounded-[4px]' : 'rounded-full'" aria-hidden="true" />
            <input
              v-model="decision.options[index]"
              :data-decision-option="`${inputKey}-${index}`"
              maxlength="200"
              class="focus-ring min-w-0 flex-1 rounded-md border border-[var(--line)] bg-transparent px-2 py-1 text-sm outline-none"
              :placeholder="`Option ${index + 1}`"
              @keydown.enter.prevent="addOption()"
              @blur="emit('commit')"
            >
            <button
              v-if="decision.options.length > 1"
              type="button"
              class="focus-ring muted grid size-6 shrink-0 place-items-center rounded-md hover:bg-[var(--panel)] hover:text-rose-600"
              :aria-label="`Remove option ${answerLabel(index)}`"
              @click="removeOption(index)"
            ><X :size="13" /></button>
          </div>
        </template>
        <!-- Answering: a click anywhere on the line picks it. -->
        <template v-else>
          <button
            v-for="(_, index) in decision.options"
            :key="index"
            type="button"
            :role="decision.multiple ? 'checkbox' : 'radio'"
            :aria-checked="isChosen(index)"
            :disabled="!editable"
            class="focus-ring flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm enabled:hover:bg-[var(--panel)] disabled:cursor-default"
            @click="toggle(index)"
          >
            <span
              class="grid size-4 shrink-0 place-items-center border transition-colors"
              :class="[decision.multiple ? 'rounded-[4px]' : 'rounded-full', isChosen(index) ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line)]']"
              aria-hidden="true"
            >
              <Check v-if="isChosen(index) && decision.multiple" :size="11" :stroke-width="3" />
              <span v-else-if="isChosen(index)" class="size-1.5 rounded-full bg-white" />
            </span>
            <span class="min-w-0 flex-1">{{ answerLabel(index) }}</span>
          </button>
        </template>
        <div v-if="decision.allowOther" class="flex items-center gap-2">
          <span
            class="grid size-4 shrink-0 place-items-center border"
            :class="[decision.multiple ? 'rounded-[4px]' : 'rounded-full', decision.other?.trim() ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line)]']"
            aria-hidden="true"
          >
            <Check v-if="decision.other?.trim() && decision.multiple" :size="11" :stroke-width="3" />
            <span v-else-if="decision.other?.trim()" class="size-1.5 rounded-full bg-white" />
          </span>
          <input
            :value="decision.other ?? ''"
            :disabled="!editable || editing"
            maxlength="500"
            class="focus-ring min-w-0 flex-1 rounded-md border border-dashed border-[var(--line)] bg-transparent px-2 py-1 text-sm outline-none"
            :placeholder="editing ? 'Other — typed in when answering' : 'Other…'"
            aria-label="Other answer"
            @input="typeOther(($event.target as HTMLInputElement).value)"
            @blur="emit('commit')"
          >
        </div>
      </div>

      <div v-if="editing" class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-6 text-xs">
        <button
          v-if="decision.options.length < 20"
          type="button"
          class="focus-ring muted flex items-center gap-1 rounded-md px-1 py-0.5 font-semibold hover:text-[var(--ink)]"
          @click="addOption()"
        ><Plus :size="13" /> Option</button>
        <div class="flex overflow-hidden rounded-md border border-[var(--line)]" role="radiogroup" aria-label="How many answers">
          <button
            v-for="choice in [{ multiple: false, label: 'Single' }, { multiple: true, label: 'Multiple' }]"
            :key="choice.label"
            type="button"
            role="radio"
            :aria-checked="decision.multiple === choice.multiple"
            class="focus-ring px-2 py-0.5 font-semibold"
            :class="decision.multiple === choice.multiple ? 'bg-[var(--accent-soft)] text-[var(--ink)]' : 'muted hover:bg-[var(--panel)]'"
            @click="setMultiple(choice.multiple)"
          >{{ choice.label }}</button>
        </div>
        <label class="muted flex cursor-pointer items-center gap-1.5 font-semibold">
          <input type="checkbox" class="focus-ring size-3.5 accent-[var(--accent)]" :checked="decision.allowOther" @change="setAllowOther(($event.target as HTMLInputElement).checked)">
          Allow “Other”
        </label>
        <button
          type="button"
          class="focus-ring ml-auto flex h-7 items-center gap-1 rounded-lg border border-[var(--line)] px-2.5 font-semibold hover:bg-[var(--panel)] disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!canFinish"
          :title="canFinish ? 'Finish setting it up; it can be answered then' : 'Add the question and at least one answer'"
          @click="finishEditing"
        ><Check :size="13" :stroke-width="2.5" /> Done</button>
      </div>
      <!-- Only once something is picked: an open question stays a plain list of answers. -->
      <div v-else-if="editable && picked > 0" class="mt-2 flex items-center pl-6 text-xs">
        <button
          type="button"
          class="focus-ring ml-auto flex h-7 items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!canDecide || Boolean(blockedBy)"
          :title="blockedBy ? `Waits for “${blockedBy}”: the to-dos go in strict order` : canDecide ? 'Settle the decision with what is picked' : 'Pick an answer first'"
          @click="emit('decide')"
        ><Lock v-if="blockedBy" :size="12" /><Check v-else :size="13" :stroke-width="2.5" /> Decide</button>
      </div>
    </template>

    <!-- Decided: the result first, then who and when. -->
    <template v-else>
      <ul class="mt-1.5 flex flex-wrap gap-1.5 pl-6" aria-label="Decided">
        <li
          v-for="index in decision.chosen"
          :key="index"
          class="flex items-center gap-1 rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-sm font-semibold"
        ><Check :size="13" :stroke-width="2.5" class="text-[var(--accent)]" /> {{ answerLabel(index) }}</li>
        <li v-if="decision.other" class="flex items-center gap-1 rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-sm font-semibold">
          <Check :size="13" :stroke-width="2.5" class="text-[var(--accent)]" /> {{ decision.other }}
        </li>
      </ul>
      <div class="muted mt-1.5 flex flex-wrap items-center gap-x-2 pl-6 text-[11px]">
        <span>Decided<template v-if="decidedBy"> by {{ displayName(decidedBy) }}</template><template v-if="decidedAt"> · {{ dateFormat.format(new Date(decidedAt)) }}</template></span>
        <span v-if="decision.options.length > decision.chosen.length" class="truncate">
          · Not picked: {{ decision.options.filter((_, index) => !decision.chosen.includes(index)).join(', ') }}
        </span>
        <button
          v-if="canEdit"
          type="button"
          class="focus-ring ml-auto flex items-center gap-1 rounded-md px-1 py-0.5 font-semibold hover:text-[var(--ink)]"
          title="Open the decision again; the answers stay picked"
          @click="emit('reopen')"
        ><RotateCcw :size="12" /> Reopen</button>
      </div>
    </template>
  </div>
</template>
