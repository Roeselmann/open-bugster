<script setup lang="ts">
import { renderMarkdown } from '~~/shared/utils/markdown'

const props = defineProps<{ source: string }>()
// `renderMarkdown` escapes raw HTML and refuses script-scheme links, which is what makes v-html safe here.
const html = computed(() => renderMarkdown(props.source))
</script>

<template>
  <div class="md-body" v-html="html" />
</template>
