<script setup lang="ts">
import { ExternalLink, Globe, Image as ImageIcon, Link as LinkIcon, LoaderCircle, Plus, RefreshCw, Type, X } from '@lucide/vue'
import type { LinkDisplay, TicketLink, TicketLinkInput } from '~~/shared/types/domain'

/**
 * A ticket's links, stacked in the editor's side column under the files. Each one shows as
 * the bare address — or, where somebody asked for it, as a card with a rendered thumbnail of
 * its page. Only then is the page read: rendering costs the server a browser tab.
 *
 * The list itself is the parent's: every change goes out as the whole new list through
 * `change`, exactly like the to-dos. What the pages said about themselves comes from the
 * saved ticket (`saved`), and a preview still `pending` is read here the moment it is shown.
 */
const props = withDefaults(defineProps<{
  links: TicketLinkInput[]
  saved?: TicketLink[]
  canEdit?: boolean
  /** Ids of the links whose preview could go on the card, and of those the card shows. */
  cardImageOptions?: Set<string>
  shownOnCard?: Set<string>
}>(), { saved: () => [], canEdit: true, cardImageOptions: () => new Set(), shownOnCard: () => new Set() })
const emit = defineEmits<{ change: [links: TicketLinkInput[]]; toggleCardImage: [id: string] }>()

const MAX_LINKS = 50
const draft = ref('')
const error = ref('')

// Previews finished since the board was loaded, by link id. The board's copy of the ticket
// catches up with its next load; until then these stand in — also after the drawer closed.
const { finished, rendering, load: loadPreview } = useLinkPreviews()
const refreshing = computed(() => new Set(rendering.value))

const savedByUrl = computed(() => new Map(props.saved.map(link => [link.url, finished.value[link.id] ?? link])))
const rows = computed(() => props.links.map(link => ({ ...link, saved: savedByUrl.value.get(link.url) ?? null })))

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

watch(() => props.saved, (saved) => {
  for (const link of saved) {
    const current = finished.value[link.id] ?? link
    if (current.preview.status === 'pending' && current.display === 'preview') loadPreview(link)
  }
}, { immediate: true })

function add() {
  const url = draft.value.trim()
  error.value = ''
  if (!url) return
  if (!/^https?:\/\/\S+$/i.test(url)) return void (error.value = 'A link has to start with http:// or https://.')
  if (props.links.some(link => link.url === url)) return void (error.value = 'This link is already on the ticket.')
  if (props.links.length >= MAX_LINKS) return void (error.value = `A ticket holds up to ${MAX_LINKS} links.`)
  // A plain address to begin with; the preview is rendered only once somebody asks for it.
  emit('change', [...props.links, { url, display: 'text' }])
  draft.value = ''
}

function remove(index: number) {
  emit('change', props.links.filter((_, position) => position !== index))
}

function setDisplay(index: number, display: LinkDisplay) {
  emit('change', props.links.map((link, position) => position === index ? { ...link, display } : link))
  // A link that was text so far may never have been read.
  const saved = rows.value[index]?.saved
  if (display === 'preview' && saved?.preview.status === 'pending') loadPreview(saved)
}

// Pasting a link is the common way in, so it is added at once rather than waiting for Enter.
function paste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text')?.trim()
  if (!text || draft.value.trim() || !/^https?:\/\/\S+$/i.test(text)) return
  event.preventDefault()
  draft.value = text
  add()
}
</script>

<template>
  <section class="space-y-2">
    <h3 class="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[.08em]"><LinkIcon :size="14" /> Links</h3>
    <p v-if="!canEdit && !links.length" class="muted text-xs">No links.</p>

    <div v-if="rows.length" class="grid grid-cols-2 gap-2 sm:grid-cols-1">
      <div v-for="(link, index) in rows" :key="link.url" class="group/link surface-strong relative min-w-0 overflow-hidden rounded-xl text-xs" :class="link.display === 'text' ? 'col-span-2 sm:col-span-1' : ''">
        <a
          v-if="link.display === 'preview'"
          :href="link.url"
          target="_blank"
          rel="noopener noreferrer"
          class="focus-ring block"
          :title="link.url"
        >
          <img v-if="link.saved?.preview.imageUrl" :src="link.saved.preview.imageUrl" alt="" class="aspect-video w-full bg-black/5 object-cover" loading="lazy">
          <!-- The generic thumbnail: what a page without an image of its own, or not read yet, shows. -->
          <div v-else class="grid aspect-video w-full place-items-center bg-[var(--accent-soft)] text-[var(--accent)]">
            <LoaderCircle v-if="!link.saved || link.saved.preview.status === 'pending' || refreshing.has(link.saved.id)" :size="20" class="animate-spin opacity-60" aria-label="Loading preview" />
            <span v-else class="flex flex-col items-center gap-1">
              <Globe :size="22" aria-hidden="true" />
              <span class="max-w-full truncate px-2 text-[10px] font-semibold">{{ host(link.url) }}</span>
            </span>
          </div>
          <div class="px-2 pb-2 pt-1.5">
            <div class="line-clamp-2 font-semibold leading-snug">{{ link.saved?.preview.title || host(link.url) }}</div>
            <div v-if="link.saved?.preview.description" class="muted mt-0.5 line-clamp-2 text-[10px] leading-snug">{{ link.saved.preview.description }}</div>
            <div class="muted mt-1 flex items-center gap-1 text-[10px]"><ExternalLink :size="10" class="shrink-0" aria-hidden="true" /> <span class="truncate">{{ link.saved?.preview.siteName || host(link.url) }}</span></div>
          </div>
        </a>
        <div v-else class="flex min-h-9 items-center gap-1.5 py-1 pl-2" :class="canEdit ? 'pr-16' : 'pr-2'">
          <LinkIcon :size="13" class="muted shrink-0" aria-hidden="true" />
          <a :href="link.url" target="_blank" rel="noopener noreferrer" class="focus-ring min-w-0 flex-1 truncate rounded font-semibold underline decoration-dotted hover:text-[var(--accent)]" :title="link.url">{{ link.url.replace(/^https?:\/\//i, '') }}</a>
        </div>

        <CardImageToggle
          v-if="link.display === 'preview' && link.saved?.preview.imageUrl && cardImageOptions.has(link.saved.id)"
          :checked="shownOnCard.has(link.saved.id)"
          :can-edit="canEdit"
          :name="host(link.url)"
          @toggle="emit('toggleCardImage', link.saved!.id)"
        />
        <!-- Over the thumbnail on a card, at the end of the row as text. -->
        <div
          v-if="canEdit"
          class="flex items-center gap-0.5"
          :class="link.display === 'preview' ? 'absolute right-1 top-1 rounded-lg bg-[var(--panel-strong)]/90 p-0.5 opacity-100 shadow-sm transition sm:opacity-0 sm:group-hover/link:opacity-100 sm:group-focus-within/link:opacity-100' : 'absolute right-1 top-1/2 -translate-y-1/2'"
        >
          <button
            v-if="link.display === 'preview' && link.saved && link.saved.preview.status !== 'pending'"
            type="button"
            class="focus-ring muted grid size-7 place-items-center rounded-lg hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:opacity-40"
            :disabled="refreshing.has(link.saved.id)"
            :aria-label="`Read the preview of ${host(link.url)} again`"
            title="Reload preview"
            @click="loadPreview(link.saved, true)"
          ><RefreshCw :size="13" /></button>
          <button
            type="button"
            class="focus-ring muted grid size-7 place-items-center rounded-lg hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
            :aria-label="link.display === 'preview' ? `Show ${host(link.url)} as text only` : `Show ${host(link.url)} with a preview`"
            :title="link.display === 'preview' ? 'Show as text only' : 'Show with preview'"
            @click="setDisplay(index, link.display === 'preview' ? 'text' : 'preview')"
          ><component :is="link.display === 'preview' ? Type : ImageIcon" :size="13" /></button>
          <button type="button" class="focus-ring grid size-7 place-items-center rounded-lg text-rose-600 hover:bg-rose-500/10" :aria-label="`Remove ${link.url}`" title="Remove" @click="remove(index)"><X :size="14" /></button>
        </div>
      </div>
    </div>

    <!-- Not a form: the editor around it is one, and forms do not nest. Enter is kept from submitting it. -->
    <div v-if="canEdit && links.length < MAX_LINKS" class="flex items-center gap-1.5">
      <input
        v-model="draft"
        type="url"
        maxlength="2000"
        inputmode="url"
        spellcheck="false"
        class="focus-ring surface-strong h-9 min-w-0 flex-1 rounded-xl px-2.5 text-xs outline-none"
        placeholder="https://…"
        aria-label="Add a link"
        @input="error = ''"
        @paste="paste"
        @keydown.enter.prevent="add"
      >
      <button type="button" class="focus-ring surface-strong grid size-9 shrink-0 place-items-center rounded-xl hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-40" :disabled="!draft.trim()" aria-label="Add link" title="Add link" @click="add"><Plus :size="15" /></button>
    </div>
    <p v-if="error" class="text-xs font-semibold text-rose-600" role="alert">{{ error }}</p>
  </section>
</template>
