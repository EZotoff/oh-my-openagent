import type { HookDeps } from "./types"
import { createAbortSessionRequest } from "./auto-retry-abort"
import { createAgentContextResolver } from "./auto-retry-agent-context"
import { createAutoRetryDispatcher } from "./auto-retry-dispatch"
import { createFallbackTimeoutHelpers } from "./auto-retry-timeout"
 import { createStaleSessionCleanup } from "./auto-retry-cleanup"
import { createSameModelRetryHelpers } from "./same-model-retry"

export function createAutoRetryHelpers(deps: HookDeps) {
  const abortSessionRequest = createAbortSessionRequest(deps)
  let autoRetryWithFallback: ReturnType<typeof createAutoRetryDispatcher>

  const { clearSessionFallbackTimeout, scheduleSessionFallbackTimeout } = createFallbackTimeoutHelpers(
    deps,
    abortSessionRequest,
    (sessionID, newModel, resolvedAgent, source) =>
      autoRetryWithFallback(sessionID, newModel, resolvedAgent, source),
  )

   autoRetryWithFallback = createAutoRetryDispatcher(
    deps,
    scheduleSessionFallbackTimeout,
    clearSessionFallbackTimeout,
   )
  const sameModelRetry = createSameModelRetryHelpers(
    deps.sessionSameModelRetryAttempts ?? new Map(),
    deps.sessionSameModelRetryTimeouts ?? new Map(),
    autoRetryWithFallback,
  )

  return {
    abortSessionRequest,
    clearSessionFallbackTimeout,
    scheduleSessionFallbackTimeout,
     autoRetryWithFallback,
    clearSameModelRetry: sameModelRetry.clear,
    scheduleSameModelRetry: sameModelRetry.schedule,
    resolveAgentForSessionFromContext: createAgentContextResolver(deps),
    cleanupStaleSessions: createStaleSessionCleanup(deps, clearSessionFallbackTimeout),
  }
}

type CreatedAutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>
export type AutoRetryHelpers = Omit<CreatedAutoRetryHelpers, "clearSameModelRetry" | "scheduleSameModelRetry"> &
  Partial<Pick<CreatedAutoRetryHelpers, "clearSameModelRetry" | "scheduleSameModelRetry">>
