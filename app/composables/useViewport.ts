// Below Tailwind's `md` the board shows one lane at a time and the header folds into a burger.
const MOBILE_QUERY = '(max-width: 767px)'

/** False during SSR and until mounted, so the server always renders the desktop layout. */
export function useIsMobile() {
  const isMobile = ref(false)
  if (import.meta.client) {
    const media = window.matchMedia(MOBILE_QUERY)
    const update = () => { isMobile.value = media.matches }
    onMounted(() => {
      update()
      media.addEventListener('change', update)
    })
    onBeforeUnmount(() => media.removeEventListener('change', update))
  }
  return isMobile
}
