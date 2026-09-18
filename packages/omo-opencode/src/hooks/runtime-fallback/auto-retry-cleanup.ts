import type { HookDeps } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
 import { clearDelegatedChildSessionBootstrap } from "../../shared/delegated-child-session-bootstrap"
import type { RuntimeFallbackTimeout } from "./types"

declare function clearTimeout(timeout: RuntimeFallbackTimeout): void

const SESSION_TTL_MS = 30 * 60 * 1000

export function createStaleSessionCleanup(
  deps: HookDeps,
  clearSessionFallbackTimeout: (sessionID: string) => void,
) {
  const {
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionStatusRetryKeys,
     internallyAbortedSessions,
    sessionSameModelRetryAttempts,
    sessionSameModelRetryTimeouts,
  } = deps

  return () => {
    const now = Date.now()
    let cleanedCount = 0
    for (const [sessionID, lastAccess] of sessionLastAccess.entries()) {
      if (now - lastAccess > SESSION_TTL_MS) {
        sessionStates.delete(sessionID)
        sessionLastAccess.delete(sessionID)
        sessionRetryInFlight.delete(sessionID)
        sessionAwaitingFallbackResult.delete(sessionID)
        internallyAbortedSessions.delete(sessionID)
        clearSessionFallbackTimeout(sessionID)
        clearDelegatedChildSessionBootstrap(sessionID)
        SessionCategoryRegistry.remove(sessionID)
         sessionStatusRetryKeys.delete(sessionID)
        sessionSameModelRetryAttempts?.delete(sessionID)
        const retryTimeout = sessionSameModelRetryTimeouts?.get(sessionID)
         if (retryTimeout !== undefined) {
           clearTimeout(retryTimeout)
          sessionSameModelRetryTimeouts?.delete(sessionID)
        }
        cleanedCount++
      }
    }
    if (cleanedCount > 0) {
      log(`[${HOOK_NAME}] Cleaned up ${cleanedCount} stale session states`)
    }
  }
}
