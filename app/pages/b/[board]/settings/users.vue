<script setup lang="ts">
const { board } = useCurrentBoard()
const { refresh: refreshBoards } = useBoards()
const { notify } = useNotify()
</script>

<template>
  <BoardMemberSettings v-if="board" :board="board" @changed="refreshBoards" @notify="notify" />
</template>
