/**
 * The colour scheme, picked by each person for themselves: `cool` (the Showcase palette, the
 * default) or `warm` (the original Open-Bugster one). Stored in this browser; app.vue applies
 * it before the first paint.
 */
export type ColorScheme = 'cool' | 'warm'

export const COLOR_SCHEMES: { value: ColorScheme, label: string }[] = [
  { value: 'cool', label: 'Cool blue' },
  { value: 'warm', label: 'Warm beige' },
]

const STORAGE_KEY = 'open-bugster-scheme'

export function useColorScheme() {
  const scheme = useState<ColorScheme>('color-scheme', () => 'cool')

  function set(value: ColorScheme) {
    scheme.value = value
    if (import.meta.client) {
      if (value === 'warm') document.documentElement.dataset.scheme = 'warm'
      else delete document.documentElement.dataset.scheme
      try { localStorage.setItem(STORAGE_KEY, value) } catch {}
    }
  }

  onMounted(() => {
    scheme.value = document.documentElement.dataset.scheme === 'warm' ? 'warm' : 'cool'
  })

  return { scheme, set }
}
