import type { UiNotice } from '~/components/UiToastHost.vue'

/**
 * The single toast the app shows at a time. Pages own the `UiToastHost`; child components
 * keep emitting `notify` upwards rather than reaching for this directly.
 */
export function useNotify() {
  const notice = useState<UiNotice | null>('notice', () => null)
  const lastId = useState('notice-id', () => 0)

  function notify(type: 'success' | 'error', text: string) {
    lastId.value += 1
    notice.value = { id: lastId.value, type, text }
  }

  function closeNotice(id: number) {
    if (notice.value?.id === id) notice.value = null
  }

  return { notice, notify, closeNotice }
}
