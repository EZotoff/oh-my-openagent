import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import { ParentWakeNotifier } from "./parent-wake-notifier"
import { WakeJournal } from "./wake-journal"

type NotifierClient = ConstructorParameters<typeof ParentWakeNotifier>[0]["client"]

type SessionMessageStub = {
  readonly info?: {
    readonly id?: string
    readonly parentID?: string
    readonly role?: string
    readonly finish?: string
    readonly tokens?: unknown
  }
  readonly parts?: readonly { readonly type?: string; readonly text?: string; readonly synthetic?: boolean }[]
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "omo-wake-watchdog-"))
  roots.push(directory)
  return directory
}

function createNotifier(directory: string, messages: readonly SessionMessageStub[]): {
  readonly notifier: ParentWakeNotifier
  readonly runWatchdog: () => Promise<void>
} {
  const client = {
    session: {
      messages: async () => ({ data: messages }),
      status: async () => ({ data: {} }),
      promptAsync: async () => ({ data: {} }),
    },
  } as unknown as NotifierClient
  const notifier = new ParentWakeNotifier(
    {
      client,
      directory,
      enqueueNotificationForParent: async (_sessionID, operation) => {
        await operation()
      },
    },
    {
      pendingRetryMs: 1_000,
      acceptedMessageSkewMs: 100,
      toolCallDeferMaxMs: 5_000,
      failureRequeueWindowMs: 1,
      userMessageInProgressWindowMs: 0,
    },
  )
  return {
    notifier,
    runWatchdog: () => (notifier as unknown as { runWatchdog: () => Promise<void> }).runWatchdog(),
  }
}

// Seeds a journal entry with a fake clock so `dispatchedAt`/`claimedAt` are far
// in the past relative to the notifier's real-clock watchdog.
function seedDispatchedWake(directory: string, sessionID: string): { wakeID: string; injectedText: string } {
  const journal = new WakeJournal(directory, { now: () => 0, pid: 1 })
  const entry = journal.queue({ sessionID, notificationText: "wake", promptContext: {}, shouldReply: true })
  const claim = journal.claim(entry.wakeID)
  journal.markDispatched(entry.wakeID, claim.generation, null)
  return { wakeID: entry.wakeID, injectedText: entry.injectedText }
}

function seedDispatchingWake(directory: string, sessionID: string): { wakeID: string } {
  const journal = new WakeJournal(directory, { now: () => 0, pid: 1 })
  const entry = journal.queue({ sessionID, notificationText: "wake", promptContext: {}, shouldReply: true })
  journal.claim(entry.wakeID)
  return { wakeID: entry.wakeID }
}

describe("ParentWakeNotifier wake-journal watchdog", () => {
  test("#given an accepted wake whose output already landed #when the watchdog runs #then the journal entry is consumed, not replayed", async () => {
    // given
    const sessionID = "watchdog-output-observed"
    const directory = createDirectory()
    const { wakeID, injectedText } = seedDispatchedWake(directory, sessionID)
    const storedText = `${injectedText}\n<!-- OMO_INTERNAL_INITIATOR -->`
    const { notifier, runWatchdog } = createNotifier(directory, [
      { info: { id: "user-w", role: "user" }, parts: [{ type: "text", text: storedText, synthetic: true }] },
      { info: { id: "assistant-w", parentID: "user-w", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
    ])

    try {
      // when
      await runWatchdog()

      // then
      const journal = new WakeJournal(directory)
      expect(journal.read(wakeID)?.state).toBe("consumed")
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given a stale dispatching claim with no persisted wake message #when the watchdog runs #then the wake is requeued for replay", async () => {
    // given
    const sessionID = "watchdog-stale-dispatching"
    const directory = createDirectory()
    const { wakeID } = seedDispatchingWake(directory, sessionID)
    const { notifier, runWatchdog } = createNotifier(directory, [])

    try {
      // when
      await runWatchdog()

      // then
      const journal = new WakeJournal(directory)
      expect(journal.read(wakeID)?.state).toBe("queued")
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(true)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })
})
