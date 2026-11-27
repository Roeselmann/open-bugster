import { boardToday, DEFAULT_TIME_ZONE } from '~~/shared/utils/due-date'

/** The time zone of the workspace on screen, which its dates and times of day are read in. */
export function useTimeZone() {
  const { workspace } = useCurrentWorkspace()
  return computed(() => workspace.value?.timeZone ?? DEFAULT_TIME_ZONE)
}

/** Today as YYYY-MM-DD in that workspace's time zone, read once when the component sets up. */
export function useBoardToday(): string {
  return boardToday(new Date(), useTimeZone().value)
}
