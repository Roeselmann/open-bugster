import type { Directive } from 'vue'

/*
 * `v-autosize` lets a textarea grow with what is typed into it. Its `rows` is the smallest it
 * gets; the binding value is the tallest, as a CSS length (default 60vh). Past that, the text
 * scrolls inside the field instead of pushing the page down.
 *
 * Done in script rather than with `field-sizing: content`, which not every browser in use
 * here supports yet.
 */

type AutosizeState = { width: number; observer?: ResizeObserver; onInput: () => void }
const states = new WeakMap<HTMLTextAreaElement, AutosizeState>()

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node
  }
  return null
}

function maxHeight(el: HTMLTextAreaElement, value: unknown): number {
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;visibility:hidden;height:${typeof value === 'string' && value ? value : '60vh'}`
  el.parentElement?.appendChild(probe)
  const height = probe.offsetHeight
  probe.remove()
  return height
}

function fit(el: HTMLTextAreaElement, value: unknown) {
  if (!el.isConnected) return
  // Collapsing the field to measure it would shorten the page for a moment and make the
  // scrolling container jump; holding its position keeps the caret where the eye is.
  const container = scrollParent(el)
  const scrollTop = container?.scrollTop
  const limit = maxHeight(el, value)
  el.style.height = 'auto'
  const borders = el.offsetHeight - el.clientHeight
  const wanted = el.scrollHeight + borders
  el.style.height = `${Math.min(wanted, limit)}px`
  el.style.overflowY = wanted > limit ? 'auto' : 'hidden'
  if (container && scrollTop !== undefined) container.scrollTop = scrollTop
}

export const vAutosize: Directive<HTMLTextAreaElement, string | undefined> = {
  mounted(el, binding) {
    const state: AutosizeState = { width: el.clientWidth, onInput: () => fit(el, binding.value) }
    el.addEventListener('input', state.onInput)
    // A narrower field wraps more lines, so a change in width has to refit; a change in
    // height is this directive's own doing and is ignored.
    state.observer = new ResizeObserver(() => {
      if (el.clientWidth === state.width) return
      state.width = el.clientWidth
      fit(el, binding.value)
    })
    state.observer.observe(el)
    states.set(el, state)
    fit(el, binding.value)
  },
  // v-model sets the value without an input event: a draft restored, a field cleared on save.
  updated(el, binding) {
    fit(el, binding.value)
  },
  beforeUnmount(el) {
    const state = states.get(el)
    if (!state) return
    el.removeEventListener('input', state.onInput)
    state.observer?.disconnect()
    states.delete(el)
  },
  getSSRProps: () => ({}),
}

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.directive('autosize', vAutosize)
})
