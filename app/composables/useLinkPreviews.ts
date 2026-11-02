import type { TicketLink } from '~~/shared/types/domain'

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Link previews being rendered, and the ones finished since the board was loaded.
 *
 * Kept here rather than in the link list, because a render takes a few seconds and outlives
 * the ticket it was asked for: the server finishes it either way, and closing the drawer must
 * not lose the answer — reopening the ticket would otherwise ask again. For the same reason
 * this is the one place below a page that reaches for `useNotify` itself: the component that
 * asked may be gone by the time the preview is ready, and nothing is left to emit upwards.
 */
export function useLinkPreviews() {
  const finished = useState<Record<string, TicketLink>>('link-previews', () => ({}))
  const rendering = useState<string[]>('link-previews-rendering', () => [])
  const { notify } = useNotify()

  async function load(link: TicketLink, refresh = false) {
    if (rendering.value.includes(link.id)) return
    rendering.value = [...rendering.value, link.id]
    const name = host(link.url)
    try {
      const response = await $fetch<{ link: TicketLink }>(`/api/links/${link.id}/preview`, { method: 'POST', body: refresh ? { refresh: true } : {} })
      finished.value = { ...finished.value, [link.id]: response.link }
      if (response.link.preview.imageUrl) notify('success', `The preview of ${name} is ready.`)
      else notify('error', `${name} could not be rendered; its card shows a placeholder.`)
    } catch {
      // A link removed in the meantime answers 404; nobody is waiting for that one.
      notify('error', `The preview of ${name} could not be made.`)
    } finally {
      rendering.value = rendering.value.filter(id => id !== link.id)
    }
  }

  return { finished, rendering, load }
}
