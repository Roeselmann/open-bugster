import { loadBoards } from '~/composables/useBoards'
import { loadWorkspaces } from '~/composables/useWorkspaces'

/**
 * Guarantees the :workspace route parameter names a workspace the user administers.
 * Everything on the settings page is an admin's to use, so anybody else — including a
 * member who can merely see the workspace — is sent home rather than shown disabled forms.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const [workspaces] = await Promise.all([loadWorkspaces(), loadBoards()])
  const workspace = workspaces.find(item => item.id === to.params.workspace)
  if (!workspace || workspace.role !== 'admin') return navigateTo('/', { replace: true })
})
