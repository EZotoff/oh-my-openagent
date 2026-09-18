import { log } from "../../shared"
import { settleAfterSessionIdle } from "../../hooks/shared/session-idle-settle"
import type { ParentWakePromptContext, PendingParentWake } from "./parent-wake-dedupe"
import { ParentWakeDispatchedTracker } from "./parent-wake-dispatched-tracker"
import { ParentWakeFlushRunner } from "./parent-wake-flush-runner"
import { ParentWakePendingQueue } from "./parent-wake-pending-queue"
import type { ToolWaitDeferralDecision } from "./parent-wake-session-history"
import { ParentWakeSessionInspector } from "./parent-wake-session-inspector"
import type { ParentWakeNotifierDeps, ParentWakeNotifierOptions } from "./parent-wake-notifier-types"
import {
  handleDispatchedParentWakeWindowElapsed,
  logParentWakeWindowRecoveryError,
  rescheduleParentWakeWindowRecoveryAfterError,
} from "./parent-wake-window-recovery"
import { WakeJournal, CLAIM_TTL_MS, WAKE_DEADLINE_MS } from "./wake-journal"

export type { ParentWakePromptContext, PendingParentWake } from "./parent-wake-dedupe"

export class ParentWakeNotifier {
  private readonly pendingQueue: ParentWakePendingQueue
  private readonly dispatchedTracker: ParentWakeDispatchedTracker
  private readonly sessionInspector: ParentWakeSessionInspector
  private readonly flushRunner: ParentWakeFlushRunner
  private readonly wakeJournal: WakeJournal
  private readonly onPendingWakeRequeued?: (sessionID: string) => void

  constructor(
    deps: ParentWakeNotifierDeps,
    options: ParentWakeNotifierOptions,
  ) {
    this.onPendingWakeRequeued = deps.onPendingWakeRequeued
    this.wakeJournal = new WakeJournal(deps.directory)
    this.pendingQueue = new ParentWakePendingQueue({
      pendingRetryMs: options.pendingRetryMs,
      enqueueNotificationForParent: deps.enqueueNotificationForParent,
    })
    this.dispatchedTracker = new ParentWakeDispatchedTracker({
      failureRequeueWindowMs: options.failureRequeueWindowMs,
      onFailureRequeueWindowElapsed: (sessionID, wake) => {
        void handleDispatchedParentWakeWindowElapsed({
          sessionID,
          wake,
          dispatchedTracker: this.dispatchedTracker,
          sessionInspector: this.sessionInspector,
          requeueWake: (latestWake) => this.requeueWake(sessionID, latestWake),
          scheduleFlush: () => this.schedulePendingParentWakeFlush(sessionID),
          onOutputObserved: () => this.observeParentSessionOutput(sessionID),
        }).catch((error: unknown) => {
          logParentWakeWindowRecoveryError(
            sessionID,
            error,
          )
          rescheduleParentWakeWindowRecoveryAfterError(
            sessionID,
            wake,
            this.dispatchedTracker,
          )
        })
      },
    })
    this.sessionInspector = new ParentWakeSessionInspector(deps.client, {
      directory: deps.directory,
      acceptedMessageSkewMs: options.acceptedMessageSkewMs,
      toolCallDeferMaxMs: options.toolCallDeferMaxMs,
      userMessageInProgressWindowMs: options.userMessageInProgressWindowMs,
      parentSessionActivityInProgressWindowMs: options.parentSessionActivityInProgressWindowMs,
    })
    this.flushRunner = new ParentWakeFlushRunner({
      notifierDeps: deps,
      pendingQueue: this.pendingQueue,
      dispatchedTracker: this.dispatchedTracker,
      sessionInspector: this.sessionInspector,
      wakeJournal: this.wakeJournal,
      onDeadLetter: (wakeID, reason) => this.reportDeadLetter(wakeID, reason),
    })
  }

  getPendingParentWakes(): Map<string, PendingParentWake> {
    return this.pendingQueue.getWakes()
  }

  getPendingParentWakeTimers(): Map<string, ReturnType<typeof setTimeout>> {
    return this.pendingQueue.getTimers()
  }

  getDispatchedParentWakes(): Map<string, PendingParentWake> {
    return this.dispatchedTracker.getWakes()
  }

  getDispatchedParentWakeTimers(): Map<string, ReturnType<typeof setTimeout>> {
    return this.dispatchedTracker.getTimers()
  }

  hasInFlightParentWakeDispatch(sessionID: string): boolean {
    return this.dispatchedTracker.hasInFlight(sessionID)
  }

  reserveNotificationPreparation(sessionID: string): void {
    this.dispatchedTracker.reserveNotificationPreparation(sessionID)
  }

  releaseNotificationPreparation(sessionID: string): void {
    this.dispatchedTracker.releaseNotificationPreparation(sessionID)
  }

  hasNotificationPreparation(sessionID: string): boolean {
    return this.dispatchedTracker.hasNotificationPreparation(sessionID)
  }

  recordParentSessionActivity(sessionID: string): void {
    this.sessionInspector.recordActivity(sessionID)
  }

  queuePendingParentWake(
    sessionID: string,
    notification: string,
    promptContext: ParentWakePromptContext,
    shouldReply: boolean,
    delayMs?: number,
  ): void {
    const existingWake = this.pendingQueue.getWake(sessionID)
    if (existingWake) {
      this.pendingQueue.queueWake(sessionID, notification, promptContext, shouldReply, existingWake.wakeID)
      const merged = this.pendingQueue.getWake(sessionID)
      if (merged?.wakeID) {
        this.wakeJournal.updateQueued(merged.wakeID, {
          notificationText: merged.notifications.join("\n\n"),
          promptContext: merged.promptContext,
          shouldReply: merged.shouldReply,
        })
      }
    } else {
      const entry = this.wakeJournal.queue({ sessionID, notificationText: notification, promptContext, shouldReply })
      this.pendingQueue.queueWake(sessionID, notification, promptContext, shouldReply, entry.wakeID)
    }
    this.schedulePendingParentWakeFlush(sessionID, delayMs)
  }

  async flushPendingParentWake(sessionID: string): Promise<void> {
    await this.flushRunner.flushPendingParentWake(sessionID)
  }

  clearDispatchedParentWake(sessionID: string): void {
    this.dispatchedTracker.clearWake(sessionID)
  }

  async observeParentSessionOutput(sessionID: string): Promise<void> {
    const messages = await this.sessionInspector.getMessages(sessionID)
    if (messages) this.wakeJournal.observeMessages(sessionID, messages)
  }

  async startupSweep(): Promise<void> {
    this.wakeJournal.cleanup()
    const now = Date.now()
    for (const entry of this.wakeJournal.list()) {
      if (entry.state === "consumed" || entry.state === "dead-letter") continue
      const messages = await this.sessionInspector.getMessages(entry.sessionID)
      if (messages && this.wakeJournal.observeMessages(entry.sessionID, messages).includes(entry.wakeID)) continue
      if (entry.state === "dispatched-awaiting-output") {
        const dispatchedAt = entry.dispatchedAt ?? now
        if (now - dispatchedAt < WAKE_DEADLINE_MS) continue
        const outcome = this.wakeJournal.failOrRequeue(entry.wakeID, "startup sweep wake deadline elapsed")
        if (outcome === "dead-letter") this.reportDeadLetter(entry.wakeID, "startup sweep wake deadline elapsed")
        continue
      }
      const claimAge = entry.claimedAt === null ? CLAIM_TTL_MS : now - entry.claimedAt
      if (entry.state === "dispatching" && claimAge < CLAIM_TTL_MS) continue
      this.pendingQueue.requeueWake(entry.sessionID, {
        wakeID: entry.wakeID,
        notifications: [entry.notificationText],
        promptContext: entry.promptContext,
        shouldReply: entry.shouldReply,
        queuedAt: entry.history[0]?.at ?? now,
      })
      this.schedulePendingParentWakeFlush(entry.sessionID, 0)
    }
  }

  async requeueDispatchedParentWake(sessionID: string, reason: string): Promise<boolean> {
    const wake = this.dispatchedTracker.getWake(sessionID)
    if (!wake) {
      return false
    }

    await settleAfterSessionIdle()

    if (await this.sessionInspector.hasAssistantOrToolOutputAfterDispatchedWake(sessionID, wake)) {
      this.clearDispatchedParentWake(sessionID)
      log("[background-agent] Ignored late parent wake failure after assistant output:", {
        sessionID,
        reason,
      })
      return false
    }

    this.dispatchedTracker.clearWake(sessionID)
    this.requeueWake(sessionID, wake)
    this.schedulePendingParentWakeFlush(sessionID)
    log("[background-agent] Requeued dispatched parent wake after prompt failure:", {
      sessionID,
      reason,
    })
    return true
  }

  requeueDispatchedParentWakeAfterEmptyAssistantTurn(sessionID: string): boolean {
    const wake = this.dispatchedTracker.getWake(sessionID)
    if (!wake) {
      return false
    }

    this.dispatchedTracker.clearWake(sessionID)
    wake.allowEmptyAssistantTurnRetry = true
    this.requeueWake(sessionID, wake)
    this.schedulePendingParentWakeFlush(sessionID, 0)
    log("[background-agent] Requeued dispatched parent wake after empty assistant turn:", { sessionID })
    return true
  }

  schedulePendingParentWakeFlush(sessionID: string, delayMs?: number): void {
    this.flushRunner.schedulePendingParentWakeFlush(sessionID, delayMs)
  }

  clearPendingParentWakeTimer(sessionID: string): void {
    this.flushRunner.clearPendingParentWakeTimer(sessionID)
  }

  shutdown(): void {
    this.pendingQueue.shutdown()
    this.dispatchedTracker.shutdown()
    this.sessionInspector.shutdown()
  }

  private requeueWake(sessionID: string, latestWake: PendingParentWake): void {
    this.pendingQueue.requeueWake(sessionID, latestWake)
    this.onPendingWakeRequeued?.(sessionID)
  }

  private reportDeadLetter(wakeID: string, reason: string): void {
    const path = this.wakeJournal.pathFor(wakeID)
    log("[background-agent] Parent wake moved to dead-letter:", { wakeID, reason, journalPath: path })
    void this.flushRunner.showDeadLetterToast(path)
  }

  private async shouldDeferParentWakeForSessionHistory(
    sessionID: string,
    wake: PendingParentWake,
  ): Promise<ToolWaitDeferralDecision> {
    return this.sessionInspector.shouldDeferForHistory(sessionID, wake)
  }
}
