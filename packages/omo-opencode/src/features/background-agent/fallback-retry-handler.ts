import type { BackgroundTask, LaunchInput } from "./types"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { ConcurrencyManager } from "./concurrency"
import type { OpencodeClient, QueueItem } from "./constants"
import { isProviderExhaustionFallbackEligible } from "@oh-my-opencode/model-core"
import { log, readConnectedProvidersCache, readProviderModelsCache } from "../../shared"
import {
  shouldRetryError,
  getNextFallback,
  hasMoreFallbacks,
  selectFallbackProvider,
} from "../../shared/model-error-classifier"
import { transformModelForProvider } from "../../shared/provider-model-id-transform"
import { abortWithTimeout } from "./abort-with-timeout"
import { ensureCurrentAttempt, scheduleRetryAttempt, startInPlaceRetryAttempt } from "./attempt-lifecycle"
import { dispatchInternalPrompt, isInternalPromptDispatchAccepted } from "../../shared/prompt-async-gate"
import { isSessionActive, settleAfterSessionIdle } from "../../hooks/shared/session-idle-settle"
import { hasVisibleAssistantResponse } from "../../hooks/runtime-fallback/visible-assistant-response"
import { extractAutoRetrySignal } from "../../hooks/runtime-fallback/error-classifier"
import { getLastUserRetryPayload } from "../../hooks/runtime-fallback/last-user-retry-parts"
import { createInternalAgentContinuationTextPart } from "../../shared/internal-initiator-marker"

export class TeamModeFallbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TeamModeFallbackError"
  }
}

function canonicalizeModelID(modelID: string): string {
  return modelID.toLowerCase().replace(/\./g, "-")
}

export type FallbackRetryHandlerDeps = {
  log: typeof log
  readProviderModelsCache: typeof readProviderModelsCache
  readConnectedProvidersCache: typeof readConnectedProvidersCache
  shouldRetryError: typeof shouldRetryError
  getNextFallback: typeof getNextFallback
  hasMoreFallbacks: typeof hasMoreFallbacks
  selectFallbackProvider: typeof selectFallbackProvider
  transformModelForProvider: typeof transformModelForProvider
  isProviderExhaustionFallbackEligible: (error: unknown) => boolean
  hasVisibleAssistantResponse: (client: OpencodeClient, directory: string, sessionID: string) => Promise<boolean>
  isSessionActive: typeof isSessionActive
}

const checkVisibleAssistantResponse = hasVisibleAssistantResponse(extractAutoRetrySignal)

const defaultFallbackRetryHandlerDeps: FallbackRetryHandlerDeps = {
  log,
  readProviderModelsCache,
  readConnectedProvidersCache,
  shouldRetryError,
  getNextFallback,
  hasMoreFallbacks,
  selectFallbackProvider,
  transformModelForProvider,
  isProviderExhaustionFallbackEligible,
  hasVisibleAssistantResponse: (client, directory, sessionID) =>
    checkVisibleAssistantResponse({ client, directory }, sessionID, undefined),
  isSessionActive,
}

export async function tryFallbackRetry(args: {
  task: BackgroundTask
  errorInfo: { name?: string; message?: string; statusCode?: number }
  source: string
  concurrencyManager: ConcurrencyManager
  client: OpencodeClient
  directory: string
  idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>
  queuesByKey: Map<string, QueueItem[]>
  processKey: (key: string) => void
  onRetrying?: (details: {
    task: BackgroundTask
    source: string
    previousSessionID?: string
    failedModel?: string
    failedError?: string
    nextModel: string
    inPlace?: boolean
  }) => void
  deps?: Partial<FallbackRetryHandlerDeps>
}): Promise<boolean> {
  const { task, errorInfo, source, concurrencyManager, client, idleDeferralTimers, queuesByKey, processKey, onRetrying } = args
  const deps = { ...defaultFallbackRetryHandlerDeps, ...args.deps }
  const fallbackChain = task.fallbackChain
  const canUseProviderExhaustionFallback = deps.isProviderExhaustionFallbackEligible(errorInfo)
  const canRetry =
    (deps.shouldRetryError(errorInfo) || canUseProviderExhaustionFallback) &&
    fallbackChain &&
    fallbackChain.length > 0 &&
    deps.hasMoreFallbacks(fallbackChain, task.attemptCount ?? 0)

  if (!canRetry) return false

  const attemptCount = task.attemptCount ?? 0
  const providerModelsCache = deps.readProviderModelsCache()
  const connectedProviders = providerModelsCache?.connected ?? deps.readConnectedProvidersCache()
  const connectedSet = connectedProviders ? new Set(connectedProviders.map(p => p.toLowerCase())) : null

  const isReachable = (entry: FallbackEntry): boolean => {
    if (!connectedSet) return true
    return entry.providers.some((provider) => connectedSet.has(provider.toLowerCase()))
  }

  let selectedAttemptCount = attemptCount
  let nextFallback: FallbackEntry | undefined
  let nextProviderID: string | undefined
  while (fallbackChain && selectedAttemptCount < fallbackChain.length) {
    const candidate = deps.getNextFallback(fallbackChain, selectedAttemptCount)
    if (!candidate) break
    selectedAttemptCount++
    if (!isReachable(candidate)) {
      deps.log("[background-agent] Skipping unreachable fallback:", {
        taskId: task.id,
        source,
        model: candidate.model,
        providers: candidate.providers,
      })
      continue
    }
    const candidateProviderID = deps.selectFallbackProvider(
      candidate.providers,
      task.model?.providerID,
    )
    const candidateModelID = deps.transformModelForProvider(candidateProviderID, candidate.model)
    const isNoOpFallback =
      !!task.model &&
      candidateProviderID.toLowerCase() === task.model.providerID.toLowerCase() &&
      canonicalizeModelID(candidateModelID) === canonicalizeModelID(task.model.modelID)
    if (isNoOpFallback) {
      deps.log("[background-agent] Skipping no-op fallback:", {
        taskId: task.id,
        source,
        model: candidate.model,
        providers: candidate.providers,
      })
      continue
    }
    nextFallback = candidate
    nextProviderID = candidateProviderID
    break
  }
  if (!nextFallback) return false

  const providerID = nextProviderID ?? deps.selectFallbackProvider(
    nextFallback.providers,
    task.model?.providerID,
  )

  deps.log("[background-agent] Retryable error, attempting fallback:", {
    taskId: task.id,
    source,
    errorName: errorInfo.name,
    errorMessage: errorInfo.message?.slice(0, 100),
    attemptCount: selectedAttemptCount,
    nextModel: `${providerID}/${nextFallback.model}`,
  })

  const previousSessionID = task.sessionId
  const previousModel = task.model

  const transformedModelId = deps.transformModelForProvider(providerID, nextFallback.model)
  const nextModel = {
    providerID,
    modelID: transformedModelId,
    variant: nextFallback.variant,
  }

  // In-place fallback (EZ-PATCH: subagent-fallback-inplace): when the failed
  // turn produced NO visible assistant output, re-prompt the SAME child session
  // with the next fallback model instead of creating a fresh session. The
  // fresh-session re-dispatch below survives as the hybrid branch for sessions
  // with visible output (partial work must not be re-sent blindly).
  if (previousSessionID && !(await deps.hasVisibleAssistantResponse(client, args.directory, previousSessionID))) {
    deps.log("[background-agent] EZ-PATCH: subagent-fallback-inplace — re-prompting same session with next fallback model", {
      taskId: task.id,
      source,
      sessionID: previousSessionID,
      nextModel: `${providerID}/${transformedModelId}`,
    })

    // A clean provider rejection (quota/entitlement) already terminated the
    // generation — only abort when the session still has an active turn, and
    // let the abort-induced session.error settle BEFORE the new attempt is
    // created: an async MessageAbortedError landing after the hop would bind
    // to the new (current) attempt via findAttemptBySession and instantly
    // fail it. Never fire-and-forget this abort.
    if (await deps.isSessionActive(client, previousSessionID)) {
      await abortWithTimeout(client, previousSessionID).catch(() => {})
      await settleAfterSessionIdle()
    }

    const inPlaceIdleTimer = idleDeferralTimers.get(task.id)
    if (inPlaceIdleTimer) {
      clearTimeout(inPlaceIdleTimer)
      idleDeferralTimers.delete(task.id)
    }

    task.attemptCount = selectedAttemptCount
    const inPlaceFailedAttemptID = ensureCurrentAttempt(task, previousModel).attemptId
    const inPlaceAttempt = inPlaceFailedAttemptID
      ? startInPlaceRetryAttempt(task, inPlaceFailedAttemptID, nextModel, previousSessionID, errorInfo.message)
      : undefined
    if (!inPlaceAttempt) {
      return false
    }

    onRetrying?.({
      task,
      source,
      previousSessionID,
      failedModel: previousModel ? `${previousModel.providerID}/${previousModel.modelID}` : undefined,
      failedError: errorInfo.message,
      nextModel: `${providerID}/${transformedModelId}`,
      inPlace: true,
    })

    const messagesResponse = await client.session.messages({
      path: { id: previousSessionID },
      query: { directory: args.directory },
    }).catch(() => undefined)
    const retryPayload = getLastUserRetryPayload(messagesResponse, previousSessionID)
    const retryParts = retryPayload.retryParts.length > 0
      ? retryPayload.retryParts
      : [createInternalAgentContinuationTextPart("continue")]

    const dispatchInPlacePrompt = (queueBehavior?: "defer") => dispatchInternalPrompt({
      mode: "async",
      client,
      sessionID: previousSessionID,
      source: `background-agent:in-place-fallback:${source}`,
      settleMs: 0,
      // The session's stream just died on the provider rejection; the gate's
      // checkToolState would see the dead turn as active forever (same rationale
      // as auto-retry-dispatch).
      checkToolState: false,
      ...(queueBehavior ? { queueBehavior } : {}),
      // The gate's 5s semantic-dedupe hold remembers FAILED prompts; a
      // per-attempt unique key keeps the re-prompt from being swallowed.
      dedupeKey: `inplace-retry-${inPlaceAttempt.attemptId}-${Date.now()}`,
      input: {
        path: { id: previousSessionID },
        body: {
          agent: task.agent,
          model: { providerID, modelID: transformedModelId },
          ...(nextModel.variant ? { variant: nextModel.variant } : {}),
          ...(retryPayload.system ? { system: retryPayload.system } : {}),
          ...(retryPayload.tools ? { tools: retryPayload.tools } : {}),
          parts: retryParts,
        },
        query: { directory: args.directory },
      },
    })

    let inPlaceResult = await dispatchInPlacePrompt("defer")
    if (inPlaceResult.status === "active") {
      inPlaceResult = await dispatchInPlacePrompt()
    }
    if (inPlaceResult.status === "reserved") {
      // Session still holds a reservation from the just-failed stream (same
      // shape as auto-retry-dispatch): retry with linear backoff until the
      // reservation is released.
      const MAX_RESERVED_RETRIES = 6
      const BASE_DELAY_MS = 500
      for (let attempt = 0; attempt < MAX_RESERVED_RETRIES; attempt++) {
        const delay = BASE_DELAY_MS * (attempt + 1)
        deps.log("[background-agent] Session reserved, retrying in-place dispatch:", {
          taskId: task.id,
          sessionID: previousSessionID,
          delayMs: delay,
        })
        await new Promise((resolve) => setTimeout(resolve, delay))
        inPlaceResult = await dispatchInPlacePrompt("defer")
        if (inPlaceResult.status !== "reserved") break
      }
    }
    if (!isInternalPromptDispatchAccepted(inPlaceResult)) {
      deps.log("[background-agent] In-place fallback dispatch not accepted:", {
        taskId: task.id,
        sessionID: previousSessionID,
        status: inPlaceResult.status,
      })
      return false
    }

    // The in-place path keeps the subagentSessions entry, the task's session
    // binding, and its concurrency slot until terminal routing — no release, no
    // fresh session, no queue push.
    return true
  }

  if (task.concurrencyKey) {
    concurrencyManager.release(task.concurrencyKey)
    task.concurrencyKey = undefined
  }

  const idleTimer = idleDeferralTimers.get(task.id)
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleDeferralTimers.delete(task.id)
  }
  task.attemptCount = selectedAttemptCount
  const failedAttemptID = ensureCurrentAttempt(task, previousModel).attemptId
  const nextAttempt = failedAttemptID
    ? scheduleRetryAttempt(task, failedAttemptID, nextModel, errorInfo.message)
    : undefined
  if (!nextAttempt) {
    return false
  }

  task.queuedAt = new Date()
  task.retryNotification = {
    previousSessionID,
    failedModel: previousModel ? `${previousModel.providerID}/${previousModel.modelID}` : undefined,
    failedError: errorInfo.message,
    nextModel: `${providerID}/${transformedModelId}`,
  }

  onRetrying?.({
    task,
    source,
    previousSessionID,
    failedModel: task.retryNotification.failedModel,
    failedError: errorInfo.message,
    nextModel: `${providerID}/${transformedModelId}`,
  })

  // Guard: a team-mode task (teamRunId set) MUST carry an onSessionCreated callback so
  // the fallback session gets registered in the team-session registry under the original
  // member slot. Without it the new session would not appear as a team participant and
  // every subsequent team tool call would throw "not in team". Fail with a bounded
  // structured error instead of silently entering that confusing runtime state.
  if (task.teamRunId && !task.onSessionCreated) {
    deps.log("[background-agent] team-mode fallback denied: task has teamRunId but no onSessionCreated; cannot preserve team membership", {
      taskId: task.id,
      teamRunId: task.teamRunId,
    })
    throw new TeamModeFallbackError(
      `team-mode fallback denied: cannot preserve team context for task ${task.id} (teamRunId=${task.teamRunId})`,
    )
  }

  const rawKey = task.model ? `${task.model.providerID}/${task.model.modelID}` : task.agent
  const key = concurrencyManager.getConcurrencyKey(rawKey)
  const queue = queuesByKey.get(key) ?? []
  const retryInput: LaunchInput = {
    description: task.description,
    prompt: task.prompt,
    agent: task.agent,
    parentSessionId: task.parentSessionId,
    parentMessageId: task.parentMessageId,
    parentModel: task.parentModel,
    parentAgent: task.parentAgent,
    parentTools: task.parentTools,
    teamRunId: task.teamRunId,
    model: nextModel,
    fallbackChain: task.fallbackChain,
    skillContent: task.skillContent,
    sessionPermission: task.sessionPermission,
    category: task.category,
    isUnstableAgent: task.isUnstableAgent,
    onSessionCreated: task.onSessionCreated,
  }

  if (previousSessionID) {
    await abortWithTimeout(client, previousSessionID).catch(() => {})
  }

  queue.push({ task, input: retryInput, attemptID: nextAttempt.attemptId, rawConcurrencyKey: rawKey })
  queuesByKey.set(key, queue)
  processKey(key)
  return true
}
