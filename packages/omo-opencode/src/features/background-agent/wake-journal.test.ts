import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { WakeJournal, WAKE_RETENTION_MS } from "./wake-journal"

const roots: string[] = []

function createJournal(now: () => number): WakeJournal {
  const directory = mkdtempSync(join(tmpdir(), "omo-wake-journal-"))
  roots.push(directory)
  return new WakeJournal(directory, { now, pid: 101 })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("WakeJournal", () => {
  test("only one claimant wins a reclaim race and stale generation cannot commit", () => {
    // given
    let now = 1_000
    const first = createJournal(() => now)
    const entry = first.queue({ sessionID: "ses-1", notificationText: "wake", promptContext: {}, shouldReply: true })
    const projectDirectory = dirname(dirname(dirname(first.directory)))
    const second = new WakeJournal(projectDirectory, { now: () => now, pid: 202 })

    // when
    const firstClaim = first.claim(entry.wakeID)
    const competingClaim = second.claim(entry.wakeID)
    now += 60_001
    const reclaimed = second.claim(entry.wakeID)
    const staleCommit = first.markDispatched(entry.wakeID, firstClaim.generation, null)

    // then
    expect(firstClaim.status).toBe("claimed")
    expect(competingClaim.status).toBe("unavailable")
    expect(reclaimed.status).toBe("claimed")
    expect(reclaimed.generation).toBe(firstClaim.generation + 1)
    expect(staleCommit).toBe(false)
  })

  test("payload hash identifies an accepted wake when message id was not committed", () => {
    // given
    const journal = createJournal(() => 2_000)
    const entry = journal.queue({ sessionID: "ses-2", notificationText: "accepted", promptContext: {}, shouldReply: true })
    const claim = journal.claim(entry.wakeID)
    journal.markDispatched(entry.wakeID, claim.generation, null)

    // when
    const consumed = journal.observeMessages("ses-2", [{
      info: { id: "user-1", role: "user" },
      parts: [{ type: "text", text: entry.injectedText, synthetic: true }],
    }, {
      info: { id: "assistant-1", parentID: "user-1", role: "assistant" },
      parts: [{ type: "text", text: "done" }],
    }])

    // then
    expect(consumed).toEqual([entry.wakeID])
    expect(journal.read(entry.wakeID)?.state).toBe("consumed")
    expect(journal.read(entry.wakeID)?.userMessageID).toBe("user-1")
  })

  test("stored wake message carrying internal markers still resolves exact identity", () => {
    // given
    const journal = createJournal(() => 2_100)
    const entry = journal.queue({ sessionID: "ses-markers", notificationText: "accepted", promptContext: {}, shouldReply: true })
    const claim = journal.claim(entry.wakeID)
    journal.markDispatched(entry.wakeID, claim.generation, null)
    // OpenCode persists the injected text with the internal-initiator marker and,
    // for noReply wakes, the noreply marker appended.
    const storedText = `${entry.injectedText}\n<!-- OMO_INTERNAL_INITIATOR -->\n<!-- OMO_INTERNAL_NOREPLY -->`

    // when
    const consumed = journal.observeMessages("ses-markers", [{
      info: { id: "user-markers", role: "user" },
      parts: [{ type: "text", text: storedText, synthetic: true }],
    }, {
      info: { id: "assistant-markers", parentID: "user-markers", role: "assistant" },
      parts: [{ type: "text", text: "done" }],
    }])

    // then
    expect(consumed).toEqual([entry.wakeID])
    expect(journal.read(entry.wakeID)?.state).toBe("consumed")
    expect(journal.read(entry.wakeID)?.userMessageID).toBe("user-markers")
  })

  test("accepted wake crash window is replayable only for an empty unknown-finish assistant", () => {
    // given
    const journal = createJournal(() => 2_500)
    const entry = journal.queue({ sessionID: "ses-crash", notificationText: "accepted", promptContext: {}, shouldReply: true })
    journal.claim(entry.wakeID)
    const acceptedUser = {
      info: { id: "user-crash", role: "user" },
      parts: [{ type: "text", text: entry.injectedText, synthetic: true }],
    }

    // when
    const status = journal.recoveryStatus(entry, [acceptedUser, {
      info: { id: "assistant-empty", parentID: "user-crash", role: "assistant", finish: "unknown", tokens: { input: 0, output: 0, reasoning: 0 } },
      parts: [],
    }])

    // then
    expect(status).toBe("replay-eligible")
  })

  test("user-aborted assistant turn cannot authorize wake replay", () => {
    // given
    const journal = createJournal(() => 2_750)
    const entry = journal.queue({ sessionID: "ses-stop", notificationText: "accepted", promptContext: {}, shouldReply: true })
    const acceptedUser = {
      info: { id: "user-stop", role: "user" },
      parts: [{ type: "text", text: entry.injectedText, synthetic: true }],
    }

    // when
    const status = journal.recoveryStatus(entry, [acceptedUser, {
      info: { id: "assistant-aborted", parentID: "user-stop", role: "assistant", finish: "aborted", tokens: { input: 0, output: 0, reasoning: 0 } },
      parts: [],
    }])

    // then
    expect(status).toBe("identity-ambiguous")
  })

  test("retry budget exhaustion dead-letters exactly once and cannot auto-replay", () => {
    // given
    let now = 3_000
    const journal = createJournal(() => now)
    const entry = journal.queue({ sessionID: "ses-3", notificationText: "retry", promptContext: {}, shouldReply: true })

    // when
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claim = journal.claim(entry.wakeID, { allowDispatchedReclaim: attempt > 0 })
      journal.markDispatched(entry.wakeID, claim.generation, null)
      now += 1_000
    }
    const deadLettered = journal.failOrRequeue(entry.wakeID, "deadline exceeded")
    const repeated = journal.failOrRequeue(entry.wakeID, "deadline exceeded again")
    const replay = journal.claim(entry.wakeID, { allowDispatchedReclaim: true })

    // then
    expect(deadLettered).toBe("dead-letter")
    expect(repeated).toBe("terminal")
    expect(replay.status).toBe("terminal")
    expect(journal.read(entry.wakeID)?.history.filter((item) => item.to === "dead-letter")).toHaveLength(1)
  })

  test("assistant output for the exact accepted user message consumes the wake", () => {
    // given
    const journal = createJournal(() => 4_000)
    const entry = journal.queue({ sessionID: "ses-4", notificationText: "observe", promptContext: {}, shouldReply: true })
    const claim = journal.claim(entry.wakeID)
    journal.markDispatched(entry.wakeID, claim.generation, "user-exact")

    // when
    journal.observeMessages("ses-4", [{
      info: { id: "assistant-2", parentID: "user-exact", role: "assistant" },
      parts: [{ type: "tool", content: { ok: true } }],
    }])

    // then
    expect(journal.read(entry.wakeID)?.state).toBe("consumed")
  })

  test("terminal files are deleted after the 24 hour retention window", () => {
    // given
    let now = 5_000
    const journal = createJournal(() => now)
    const entry = journal.queue({ sessionID: "ses-5", notificationText: "retain", promptContext: {}, shouldReply: true })
    const claim = journal.claim(entry.wakeID)
    journal.markDispatched(entry.wakeID, claim.generation, "user-5")
    journal.consume(entry.wakeID, "output observed")
    now += WAKE_RETENTION_MS + 1
    utimesSync(journal.pathFor(entry.wakeID), new Date(now), new Date(5_000))

    // when
    const deleted = journal.cleanup()

    // then
    expect(deleted).toBe(1)
    expect(() => readFileSync(journal.pathFor(entry.wakeID), "utf8")).toThrow()
  })
})
