<script setup lang="ts">
import { Camera, Trash2, UserRound } from '@lucide/vue'

const { user } = useAuth()
const { notify } = useNotify()
const session = useUserSession()

const profile = reactive({ email: '', firstName: '', lastName: '' })
watchEffect(() => {
  profile.email = user.value?.email || ''
  profile.firstName = user.value?.firstName || ''
  profile.lastName = user.value?.lastName || ''
})

/* ── portrait ── */

const fileInput = ref<HTMLInputElement | null>(null)
/**
 * The picked file as a data URL while the crop dialog is open. Not an object URL: the content
 * security policy admits `data:` images and not `blob:` ones, and widening it for this is not worth it.
 */
const cropSource = ref<string | null>(null)
const avatarPending = ref(false)

function pickPhoto(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    notify('error', 'Pick a picture: a JPEG, PNG or WebP file.')
    return
  }
  const reader = new FileReader()
  reader.onload = () => { cropSource.value = typeof reader.result === 'string' ? reader.result : null }
  reader.onerror = () => notify('error', 'The file could not be read.')
  reader.readAsDataURL(file)
}

function closeCrop() {
  cropSource.value = null
}

async function saveAvatar(image: string) {
  avatarPending.value = true
  try {
    await $fetch('/api/profile/avatar', { method: 'PUT', body: { image } })
    // The header draws the picture from the session, which adds it on every fetch.
    await session.fetch()
    closeCrop()
    notify('success', 'Your portrait was saved.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    avatarPending.value = false
  }
}

async function removeAvatar() {
  avatarPending.value = true
  try {
    await $fetch('/api/profile/avatar', { method: 'DELETE' })
    await session.fetch()
    notify('success', 'Your portrait was removed. Your initials are back.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    avatarPending.value = false
  }
}

const saving = ref(false)
async function saveProfile() {
  saving.value = true
  try {
    await $fetch('/api/profile', { method: 'PATCH', body: { ...profile } })
    // The cookie carries the display name and the address, so it has to be refreshed
    // alongside the row or the header keeps showing the old one.
    await session.fetch()
    notify('success', 'Your profile was saved.')
  } catch (error) {
    notify('error', errorText(error))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Account</p>
      <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><Camera :size="18" aria-hidden="true" /> Portrait</h2>
      <p class="muted mt-1 text-sm">Shown in a circle next to your name on cards, comments and member lists.</p>
    </header>
    <div class="flex flex-wrap items-center gap-4 px-5 py-5">
      <span class="grid size-20 shrink-0 place-items-center overflow-hidden rounded-full">
        <img v-if="user?.avatarUrl" :src="user.avatarUrl" alt="Your portrait" class="size-full object-cover">
        <UiAvatar v-else :person="user" size="lg" class="!size-20 !text-xl" />
      </span>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          :disabled="avatarPending"
          class="focus-ring flex h-10 items-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50"
          @click="fileInput?.click()"
        >
          <Camera :size="15" aria-hidden="true" /> {{ user?.avatarUrl ? 'Choose another photo' : 'Upload a photo' }}
        </button>
        <button
          v-if="user?.avatarUrl"
          type="button"
          :disabled="avatarPending"
          class="focus-ring flex h-10 items-center gap-2 rounded-xl border border-[var(--line)] px-4 text-sm font-semibold transition hover:bg-[var(--panel-strong)] disabled:opacity-50"
          @click="removeAvatar"
        >
          <Trash2 :size="15" aria-hidden="true" /> Remove
        </button>
        <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" tabindex="-1" aria-hidden="true" @change="pickPhoto">
      </div>
    </div>
    <PortraitCropDialog :source="cropSource" :pending="avatarPending" @cancel="closeCrop" @confirm="saveAvatar" />
  </section>

  <section class="surface rounded-2xl">
    <header class="border-b border-[var(--line)] px-5 py-4">
      <p class="muted text-[10px] font-bold uppercase tracking-[.14em]">Account</p>
      <h2 class="mt-0.5 flex items-center gap-2 text-lg font-bold"><UserRound :size="18" aria-hidden="true" /> Name and address</h2>
      <p class="muted mt-1 text-sm">Shown on the tickets you create and the comments you write, everywhere at once.</p>
    </header>
    <form class="space-y-4 px-5 py-5" @submit.prevent="saveProfile">
      <label class="block">
        <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Email</span>
        <input v-model="profile.email" required type="email" maxlength="160" autocomplete="email" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
        <span class="muted mt-1.5 block text-xs">Everything you have filed, written or been assigned follows you to the new address.</span>
      </label>
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block">
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">First name</span>
          <input v-model="profile.firstName" required maxlength="60" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
        </label>
        <label class="block">
          <span class="mb-2 block text-xs font-bold uppercase tracking-[.08em]">Last name</span>
          <input v-model="profile.lastName" maxlength="60" class="focus-ring surface-strong h-11 w-full rounded-xl px-3 text-sm outline-none">
        </label>
      </div>
      <div class="flex justify-end">
        <button :disabled="saving" class="focus-ring h-10 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--canvas)] transition hover:opacity-85 disabled:opacity-50">
          {{ saving ? 'Saving…' : 'Save profile' }}
        </button>
      </div>
    </form>
  </section>
  </div>
</template>
