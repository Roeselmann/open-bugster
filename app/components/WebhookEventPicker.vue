<script setup lang="ts">
/**
 * The event checkboxes, shared by the add form and by editing an existing webhook — so the
 * two can never offer different events. Each box carries its own explanation as a tooltip;
 * the long version lives in the reference below the list.
 */
const model = defineModel<string[]>({ required: true })

function toggle(event: string) {
  model.value = model.value.includes(event)
    ? model.value.filter(held => held !== event)
    : [...model.value, event]
}
</script>

<template>
  <div class="flex flex-wrap gap-x-4 gap-y-1.5">
    <label
      v-for="entry in WEBHOOK_EVENTS"
      :key="entry.event"
      class="flex cursor-pointer items-center gap-2 text-sm"
      :title="entry.fires"
    >
      <input type="checkbox" :checked="model.includes(entry.event)" class="focus-ring size-4 rounded" @change="toggle(entry.event)">
      <span class="font-mono text-xs">{{ entry.event }}</span>
    </label>
  </div>
</template>
