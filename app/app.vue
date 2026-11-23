<script setup lang="ts">
useHead({
  htmlAttrs: { lang: 'en' },
  script: [{
    innerHTML: `try{if(localStorage.getItem('open-bugster-scheme')==='warm')document.documentElement.dataset.scheme='warm'}catch(e){}`,
    tagPosition: 'head'
  }]
})
</script>

<template>
  <NuxtPage />
</template>
