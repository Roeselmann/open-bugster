<script setup lang="ts">
useHead({
  htmlAttrs: { lang: 'en' },
  script: [{
    innerHTML: `try{const t=localStorage.getItem('open-bugster-theme')||localStorage.getItem('bugster-theme');const d=t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}`,
    tagPosition: 'head'
  }]
})
</script>

<template>
  <NuxtPage />
</template>
