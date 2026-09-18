 import type { AutoRetryDispatchOutcome, RuntimeFallbackTimeout } from "./types"

declare function setTimeout(callback: () => void | Promise<void>, delay?: number): RuntimeFallbackTimeout
declare function clearTimeout(timeout: RuntimeFallbackTimeout): void

const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 120_000

export function createSameModelRetryHelpers(
  attempts: Map<string, number>,
  timeouts: Map<string, RuntimeFallbackTimeout>,
  dispatch: (
    sessionID: string,
    model: string,
    resolvedAgent: string | undefined,
    source: string,
  ) => Promise<AutoRetryDispatchOutcome>,
) {
  const clear = (sessionID: string): void => {
    const timeout = timeouts.get(sessionID)
    if (timeout !== undefined) {
      clearTimeout(timeout)
      timeouts.delete(sessionID)
    }
    attempts.delete(sessionID)
  }

  const schedule = (sessionID: string, model: string, resolvedAgent: string | undefined): void => {
    if (timeouts.has(sessionID)) return

    const attempt = attempts.get(sessionID) ?? 0
    const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
    const timeout = setTimeout(async () => {
      timeouts.delete(sessionID)
      attempts.set(sessionID, attempt + 1)
      const outcome = await dispatch(sessionID, model, resolvedAgent, "session.error.same-model")
      if (!outcome.accepted) {
        schedule(sessionID, model, resolvedAgent)
      }
    }, delay)
    timeouts.set(sessionID, timeout)
  }

  return { clear, schedule }
}
