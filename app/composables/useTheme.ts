export function useTheme() {
  const isDark = useState('theme-dark', () => false)

  function apply(value: boolean) {
    isDark.value = value
    if (import.meta.client) {
      document.documentElement.classList.toggle('dark', value)
      localStorage.setItem('open-bugster-theme', value ? 'dark' : 'light')
    }
  }

  onMounted(() => {
    isDark.value = document.documentElement.classList.contains('dark')
  })

  return { isDark, toggle: () => apply(!isDark.value) }
}
