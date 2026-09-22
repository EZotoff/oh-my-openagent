/**
 * Process-crash-durable parent-wake outbox. Writes use temp-file rename but do
 * not fsync, so power-loss durability is outside the threat model.
 *
 * Dead letters are terminal and never replayed. An operator may inspect the
 * journal file, fix the cause, then either delete it to drop the wake or edit
 * its state to `queued` to revive it. Removing this feature is rollback-safe:
 * older OMO builds never read `.omo/run-continuation/wakes/`; the directory may
 * be deleted to purge retained entries.
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { stripInternalInitiatorMarkers } from "../../shared"
import { isEmptyNoProgressAssistantTurnInfo } from "./empty-assistant-turn"
import type { ParentWakeSessionMessage } from "./parent-wake-session-message"

export const CLAIM_TTL_MS = 60_000
export const WAKE_DEADLINE_MS = 30 * 60_000
export const WAKE_WATCHDOG_INTERVAL_MS = 10 * 60_000
export const WAKE_RETENTION_MS = 24 * 60 * 60_000
export const MAX_WAKE_ATTEMPTS = 3

const WakeStateSchema = z.enum(["queued", "dispatching", "dispatched-awaiting-output", "consumed", "dead-letter"])
const HistorySchema = z.object({
  at: z.number(),
  from: WakeStateSchema.nullable(),
  to: WakeStateSchema,
  reason: z.string(),
})
const PromptContextSchema = z.object({
  agent: z.string().optional(),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  variant: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
})
const WakeEntrySchema = z.object({
  wakeID: z.string(),
  sessionID: z.string(),
  directory: z.string(),
  notificationText: z.string(),
  injectedText: z.string(),
  payloadHash: z.string(),
  promptContext: PromptContextSchema,
  shouldReply: z.boolean(),
  userMessageID: z.string().nullable(),
  state: WakeStateSchema,
  attemptCount: z.number().int().nonnegative(),
  claimedBy: z.number().int().nullable(),
  generation: z.number().int().nonnegative(),
  claimedAt: z.number().nullable(),
  firstDispatchedAt: z.number().nullable(),
  dispatchedAt: z.number().nullable(),
  terminalAt: z.number().nullable(),
  lastError: z.string().nullable(),
  history: z.array(HistorySchema),
})

export type WakeEntry = z.infer<typeof WakeEntrySchema>
export type WakePromptContext = z.infer<typeof PromptContextSchema>

export type WakeClaimResult = {
  readonly status: "claimed" | "unavailable" | "terminal" | "missing"
  readonly generation: number
  readonly entry?: WakeEntry
}

export type WakeRecoveryStatus = "output-observed" | "replay-eligible" | "identity-absent" | "identity-ambiguous"

type WakeJournalOptions = {
  readonly now?: () => number
  readonly pid?: number
}

type QueueWakeInput = {
  readonly sessionID: string
  readonly notificationText: string
  readonly promptContext: WakePromptContext
  readonly shouldReply: boolean
}

export class WakeJournal {
  readonly directory: string
  private readonly now: () => number
  private readonly pid: number

  constructor(projectDirectory: string, options: WakeJournalOptions = {}) {
    this.directory = join(projectDirectory, ".omo", "run-continuation", "wakes")
    this.now = options.now ?? Date.now
    this.pid = options.pid ?? process.pid
  }

  pathFor(wakeID: string): string {
    return join(this.directory, `${wakeID}.json`)
  }

  queue(input: QueueWakeInput): WakeEntry {
    const now = this.now()
    const wakeID = randomUUID()
    const injectedText = appendWakeMarker(input.notificationText, wakeID)
    const entry: WakeEntry = {
      wakeID,
      sessionID: input.sessionID,
      directory: this.directory,
      notificationText: input.notificationText,
      injectedText,
      payloadHash: hashWakePayload(injectedText),
      promptContext: input.promptContext,
      shouldReply: input.shouldReply,
      userMessageID: null,
      state: "queued",
      attemptCount: 0,
      claimedBy: null,
      generation: 0,
      claimedAt: null,
      firstDispatchedAt: null,
      dispatchedAt: null,
      terminalAt: null,
      lastError: null,
      history: [{ at: now, from: null, to: "queued", reason: "queued" }],
    }
    this.write(entry)
    return entry
  }

  read(wakeID: string): WakeEntry | undefined {
    try {
      return WakeEntrySchema.parse(JSON.parse(readFileSync(this.pathFor(wakeID), "utf8")))
    } catch (error) {
      if (isMissingFileError(error)) return undefined
      throw error
    }
  }

  updateQueued(wakeID: string, input: Omit<QueueWakeInput, "sessionID">): WakeEntry | undefined {
    const current = this.read(wakeID)
    if (!current || current.state !== "queued") return current
    const injectedText = appendWakeMarker(input.notificationText, wakeID)
    const updated: WakeEntry = {
      ...current,
      notificationText: input.notificationText,
      injectedText,
      payloadHash: hashWakePayload(injectedText),
      promptContext: input.promptContext,
      shouldReply: input.shouldReply,
    }
    this.write(updated)
    return updated
  }

  list(): WakeEntry[] {
    try {
      return readdirSync(this.directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => WakeEntrySchema.parse(JSON.parse(readFileSync(join(this.directory, name), "utf8"))))
    } catch (error) {
      if (isMissingFileError(error)) return []
      throw error
    }
  }

  claim(wakeID: string, options: { readonly allowDispatchedReclaim?: boolean } = {}): WakeClaimResult {
    const current = this.read(wakeID)
    if (!current) {
      const claimInProgress = this.hasClaimFile(wakeID)
      return { status: claimInProgress ? "unavailable" : "missing", generation: 0 }
    }
    if (isTerminal(current.state)) return { status: "terminal", generation: current.generation, entry: current }
    const now = this.now()
    if (current.state === "dispatching" && current.claimedAt !== null && now - current.claimedAt < CLAIM_TTL_MS) {
      return { status: "unavailable", generation: current.generation, entry: current }
    }
    if (current.state === "dispatched-awaiting-output") {
      const reclaimable = options.allowDispatchedReclaim === true
      if (!reclaimable) return { status: "unavailable", generation: current.generation, entry: current }
    }
    if (current.attemptCount >= MAX_WAKE_ATTEMPTS || deadlineExpired(current, now)) {
      const terminal = this.transition(current, "dead-letter", "wake deadline or retry budget exhausted")
      return { status: "terminal", generation: terminal.generation, entry: terminal }
    }

    const generation = current.generation + 1
    const claimedPath = join(this.directory, `${wakeID}.claimed.${generation}`)
    try {
      renameSync(this.pathFor(wakeID), claimedPath)
    } catch (error) {
      if (isMissingFileError(error)) return { status: "unavailable", generation: current.generation }
      throw error
    }
    const claimed: WakeEntry = {
      ...current,
      state: "dispatching",
      attemptCount: current.attemptCount + 1,
      claimedBy: this.pid,
      generation,
      claimedAt: now,
      lastError: null,
      history: [...current.history, { at: now, from: current.state, to: "dispatching", reason: "claimed" }],
    }
    this.writeToPath(claimedPath, claimed)
    renameSync(claimedPath, this.pathFor(wakeID))
    return { status: "claimed", generation, entry: claimed }
  }

  markDispatched(wakeID: string, generation: number, userMessageID: string | null): boolean {
    const current = this.read(wakeID)
    if (!current || current.state !== "dispatching" || current.generation !== generation) return false
    const now = this.now()
    this.write({
      ...current,
      state: "dispatched-awaiting-output",
      userMessageID,
      firstDispatchedAt: current.firstDispatchedAt ?? now,
      dispatchedAt: now,
      claimedBy: null,
      claimedAt: null,
      history: [...current.history, { at: now, from: current.state, to: "dispatched-awaiting-output", reason: "prompt accepted" }],
    })
    return true
  }

  consume(wakeID: string, reason: string): boolean {
    const current = this.read(wakeID)
    if (!current || isTerminal(current.state)) return false
    this.transition(current, "consumed", reason)
    return true
  }

  failOrRequeue(wakeID: string, reason: string): "queued" | "dead-letter" | "terminal" | "missing" {
    const current = this.read(wakeID)
    if (!current) return "missing"
    if (isTerminal(current.state)) return "terminal"
    if (current.attemptCount >= MAX_WAKE_ATTEMPTS || deadlineExpired(current, this.now())) {
      this.transition({ ...current, lastError: reason }, "dead-letter", reason)
      return "dead-letter"
    }
    this.transition({ ...current, lastError: reason }, "queued", reason)
    return "queued"
  }

  observeMessages(sessionID: string, messages: readonly ParentWakeSessionMessage[]): string[] {
    const consumed: string[] = []
    for (const entry of this.list()) {
      if (entry.sessionID !== sessionID || entry.state !== "dispatched-awaiting-output") continue
      const identity = resolveWakeUserMessageID(entry, messages)
      if (!identity) continue
      const outputObserved = messages.some((message) => {
        if (!messageHasOutput(message)) return false
        return message.info?.parentID === identity
      })
      if (!outputObserved) continue
      this.write({ ...entry, userMessageID: identity })
      if (this.consume(entry.wakeID, "assistant or tool output observed")) consumed.push(entry.wakeID)
    }
    return consumed
  }

  recoveryStatus(entry: WakeEntry, messages: readonly ParentWakeSessionMessage[]): WakeRecoveryStatus {
    const identity = resolveWakeUserMessageID(entry, messages)
    if (!identity) return "identity-absent"
    if (messages.some((message) => message.info?.parentID === identity && messageHasOutput(message))) {
      return "output-observed"
    }
    const lastAssistant = [...messages].reverse().find((message) => getMessageRole(message) === "assistant")
    if (!lastAssistant || !isEmptyNoProgressAssistantTurnInfo(lastAssistant.info)) return "identity-ambiguous"
    return "replay-eligible"
  }

  cleanup(): number {
    let deleted = 0
    const now = this.now()
    for (const entry of this.list()) {
      if (!isTerminal(entry.state) || entry.terminalAt === null || now - entry.terminalAt < WAKE_RETENTION_MS) continue
      unlinkSync(this.pathFor(entry.wakeID))
      deleted += 1
    }
    return deleted
  }

  private transition(entry: WakeEntry, state: WakeEntry["state"], reason: string): WakeEntry {
    const now = this.now()
    const next: WakeEntry = {
      ...entry,
      state,
      claimedBy: state === "dispatching" ? entry.claimedBy : null,
      claimedAt: state === "dispatching" ? entry.claimedAt : null,
      terminalAt: isTerminal(state) ? now : null,
      history: [...entry.history, { at: now, from: entry.state, to: state, reason }],
    }
    this.write(next)
    return next
  }

  private write(entry: WakeEntry): void {
    mkdirSync(this.directory, { recursive: true })
    const path = this.pathFor(entry.wakeID)
    const temporaryPath = `${path}.${this.pid}.${randomUUID()}.tmp`
    this.writeToPath(temporaryPath, entry)
    renameSync(temporaryPath, path)
  }

  private writeToPath(path: string, entry: WakeEntry): void {
    writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, "utf8")
  }

  private hasClaimFile(wakeID: string): boolean {
    try {
      return readdirSync(this.directory).some((name) => name.startsWith(`${wakeID}.claimed.`))
    } catch (error) {
      if (isMissingFileError(error)) return false
      throw error
    }
  }
}

export function wakeMarker(wakeID: string): string {
  return `<!-- OMO_WAKE:${wakeID} -->`
}

export function appendWakeMarker(notificationText: string, wakeID: string): string {
  return `${notificationText}\n${wakeMarker(wakeID)}`
}

export function hashWakePayload(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

// The stored user message is not byte-identical to the injected text: OpenCode
// appends the internal-initiator marker (and, for noReply wakes, the noreply
// marker) before persisting. Match the per-wake OMO_WAKE marker first (exact
// identity), then fall back to the payload hash over the marker-stripped text.
function resolveWakeUserMessageID(entry: WakeEntry, messages: readonly ParentWakeSessionMessage[]): string | undefined {
  if (entry.userMessageID !== null) return entry.userMessageID
  const marker = wakeMarker(entry.wakeID)
  for (const message of messages) {
    if (getMessageRole(message) !== "user" || !isSyntheticWakeMessage(message)) continue
    const text = message.parts?.map((part) => part.text ?? "").join("") ?? ""
    if (text.includes(marker) || hashWakePayload(stripInternalInitiatorMarkers(text)) === entry.payloadHash) {
      return getMessageID(message)
    }
  }
  return undefined
}

function isSyntheticWakeMessage(message: ParentWakeSessionMessage): boolean {
  return message.parts?.some((part) => part.synthetic === true
    || part.text?.includes("<system-reminder>") === true
    || part.text?.includes("<!-- OMO_WAKE:") === true) ?? false
}

function messageHasOutput(message: ParentWakeSessionMessage): boolean {
  const role = getMessageRole(message)
  if (role !== "assistant" && role !== "tool") return false
  if (message.info?.error !== undefined || message.error !== undefined) return false
  if (!message.parts || message.parts.length === 0) return false
  return message.parts.some((part) => part.type === "tool"
    || part.type === "tool_use"
    || part.type === "tool_result"
    || (typeof part.text === "string" && part.text.trim().length > 0)
    || part.content !== undefined)
}

function getMessageID(message: ParentWakeSessionMessage): string | undefined {
  return message.info?.id ?? message.id
}

function getMessageRole(message: ParentWakeSessionMessage): string | undefined {
  return message.info?.role ?? message.role
}

function deadlineExpired(entry: WakeEntry, now: number): boolean {
  return entry.firstDispatchedAt !== null && now - entry.firstDispatchedAt >= WAKE_DEADLINE_MS
}

function isTerminal(state: WakeEntry["state"]): boolean {
  return state === "consumed" || state === "dead-letter"
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
