import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ParentWakeNotifier } from "./parent-wake-notifier"
import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../../hooks/shared/prompt-async-gate"

// EZ-PATCH regression test: ses_ef45bab34ffenpIPZTQomDmsQ9 incident (2026-10-07).
// A reply-required parent wake queued behind an IDLE parent session whose last
// assistant turn looks like a pending tool turn (aborted/dead stream, empty
// trailing assistant output) was held forever by the history-deferral guards:
// "Holding parent wake during stale tool-call deferral" ->
// "Deferred retained reply-required parent wake until parent session is safe"
// repeated every ~1s with no ceiling. The idle-deferral ceiling now
// force-dispatches the wake once its queued age exceeds the active-defer
// ceiling, because an idle session has no in-flight turn to fork.

type PromptAsyncCall = {
  path: { id: string }
  body: {
    noReply?: boolean
    parts?: unknown[]
  }
  query?: {
    directory: string
  }
}

type SessionMessageStub = {
  info?: {
    role?: string
    finish?: string
    time?: { created?: number; completed?: number }
  }
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean; state?: { status?: string } }>
}

const FINAL_WAKE = [
  "<system-reminder>",
  "[BACKGROUND TASK COMPLETED]",
  "[ALL BACKGROUND TASKS COMPLETE]",
  "",
  "**Completed:**",
  "- `task-a`: task A",
  "",
  'Use `background_output(task_id="<id>")` to retrieve each result.',
  "</system-reminder>",
].join("\n")

// Mirrors the incident session tail: assistant fired a background `task` tool,
// turn ended with an empty trailing assistant message that never finalized.
const BLOCKED_MESSAGES: SessionMessageStub[] = [
  {
    info: { role: "user", time: { created: 80_000 } },
    parts: [{ type: "text", text: "start work" }],
  },
  {
    info: { role: "assistant", finish: "tool-calls", time: { created: 99_500 } },
    parts: [{ type: "tool", state: { status: "running" } }],
  },
]

function createNotifier(args: {
  sessionStatuses: Record<string, { type: string }>
  messagesProvider: () => SessionMessageStub[]
}): {
  notifier: ParentWakeNotifier
  promptAsyncCalls: PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:1" })
  Object.assign(client.session, {
    messages: async () => ({ data: args.messagesProvider() }),
    status: async () => ({ data: args.sessionStatuses }),
    promptAsync: async (call: PromptAsyncCall) => {
      promptAsyncCalls.push(call)
      return { data: {} }
    },
    abort: async () => ({ data: {} }),
  })

  const notifier = new ParentWakeNotifier(
    {
      client,
      directory: "/tmp/test-omo",
      enqueueNotificationForParent: async (_sessionID, operation) => {
        await operation()
      },
    },
    {
      pendingRetryMs: 1_000,
      acceptedMessageSkewMs: 5_000,
      toolCallDeferMaxMs: 5_000,
      failureRequeueWindowMs: 5_000,
      userMessageInProgressWindowMs: 2_000,
      parentSessionActivityInProgressWindowMs: 0,
    },
  )

  return { notifier, promptAsyncCalls }
}

function releaseParentWakeHold(sessionID: string): void {
  releasePromptAsyncReservation(sessionID, "test:simulate-expired-parent-wake-hold", {
    reservedBy: "background-agent-parent-wake",
  })
}

afterEach(() => {
  releaseAllPromptAsyncReservationsForTesting()
})

describe("parent wake idle deferral ceiling", () => {
  test("#given young wake and idle blocked parent #then it admits noReply and retains the wake", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "idle" } },
      messagesProvider: () => BLOCKED_MESSAGES,
    })
    notifier.queuePendingParentWake("parent-1", FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      // when
      await notifier.flushPendingParentWake("parent-1")

      // then — admit-only deposit, wake retained for a future reply
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(true)
      expect(notifier.getPendingParentWakes().get("parent-1")?.noReplyAdmittedAt).toBeDefined()
    } finally {
      notifier.shutdown()
    }
  })

  test("#given aged retained wake and idle blocked parent #then it force-dispatches a reply instead of spinning forever", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "idle" } },
      messagesProvider: () => BLOCKED_MESSAGES,
    })
    notifier.queuePendingParentWake("parent-1", FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      // when — first flush admits the noReply deposit (young wake)
      await notifier.flushPendingParentWake("parent-1")

      // when — the wake ages past the active-defer ceiling while the parent
      // stays idle and blocked (the incident deadlock loop)
      const wake = notifier.getPendingParentWakes().get("parent-1")
      if (!wake) {
        throw new Error("expected retained wake")
      }
      wake.queuedAt = Date.now() - 120_000
      releaseParentWakeHold("parent-1")
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then — a reply-producing dispatch goes out despite the blocked history
      expect(promptAsyncCalls.length).toBeGreaterThanOrEqual(2)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      const lastCall = promptAsyncCalls[promptAsyncCalls.length - 1]
      expect(lastCall?.body.noReply).not.toBe(true)
      expect(notifier.getPendingParentWakes().has("parent-1")).toBe(false)
    } finally {
      notifier.shutdown()
    }
  })

  test("#given aged retained wake and busy blocked parent #then it still holds (no fork against a live turn)", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { "parent-1": { type: "busy" } },
      messagesProvider: () => BLOCKED_MESSAGES,
    })
    notifier.queuePendingParentWake("parent-1", FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      // when
      await notifier.flushPendingParentWake("parent-1")
      const wake = notifier.getPendingParentWakes().get("parent-1")
      if (!wake) {
        throw new Error("expected retained wake")
      }
      wake.queuedAt = Date.now() - 120_000
      releaseParentWakeHold("parent-1")
      notifier.clearPendingParentWakeTimer("parent-1")
      await notifier.flushPendingParentWake("parent-1")

      // then — busy session: admit-only at most, never a forced reply
      const replyCalls = promptAsyncCalls.filter((call) => call.body.noReply !== true)
      expect(replyCalls).toHaveLength(0)
      expect(notifier.getPendingParentWakes().get("parent-1")?.shouldReply).toBe(true)
    } finally {
      notifier.shutdown()
    }
  })
})
