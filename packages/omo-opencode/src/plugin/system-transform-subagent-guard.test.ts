import { describe, expect, test } from "bun:test"
import type { DefaultModeConfig } from "../config/schema/default-mode"
import { createSystemTransformHandler, type SystemTransformSessionState } from "./system-transform"

const ULTRAWORK_INSTRUCTION_MARKER = "<ultrawork-mode>matrix ultrawork instructions"
const DEFAULT_MODE: DefaultModeConfig = { ultrawork: true }

function createSessionState(overrides?: Partial<SystemTransformSessionState>): SystemTransformSessionState {
  return {
    isSubagentSession: () => false,
    getMainSessionID: () => undefined,
    ...overrides,
  }
}

async function renderSystemPrompt(
  sessionID: string,
  sessionState?: SystemTransformSessionState,
): Promise<string> {
  const handler = createSystemTransformHandler(
    DEFAULT_MODE,
    () => ULTRAWORK_INSTRUCTION_MARKER,
    sessionState,
  )
  const output = { system: ["base system prompt"] }

  await handler(
    {
      sessionID,
      model: { id: "gpt-5.5", providerID: "openai" },
    },
    output,
  )

  return output.system.join("\n")
}

describe("system-transform default-mode ultrawork subagent guard", () => {
  test("#given main session with default ultrawork #when system transform runs #then ultrawork message injected", async () => {
    // given
    const sessionState = createSessionState({
      isSubagentSession: (sessionID) => sessionID === "other-child",
      getMainSessionID: () => "main-session",
    })

    // when
    const systemPrompt = await renderSystemPrompt("main-session", sessionState)

    // then
    expect(systemPrompt.includes(ULTRAWORK_INSTRUCTION_MARKER)).toBe(true)
  })

  test("#given registered subagent session with default ultrawork #when system transform runs #then ultrawork message NOT injected", async () => {
    // given
    const sessionState = createSessionState({
      isSubagentSession: (sessionID) => sessionID === "task-child-session",
      getMainSessionID: () => "main-session",
    })

    // when
    const systemPrompt = await renderSystemPrompt("task-child-session", sessionState)

    // then
    expect(systemPrompt.includes(ULTRAWORK_INSTRUCTION_MARKER)).toBe(false)
  })

  test("#given non-main session with default ultrawork #when system transform runs #then ultrawork message NOT injected", async () => {
    // given — session is neither the registered main session nor in the
    // subagent set (mirrors keyword-detector hook.ts non-main guard)
    const sessionState = createSessionState({
      isSubagentSession: () => false,
      getMainSessionID: () => "main-session",
    })

    // when
    const systemPrompt = await renderSystemPrompt("some-other-session", sessionState)

    // then
    expect(systemPrompt.includes(ULTRAWORK_INSTRUCTION_MARKER)).toBe(false)
  })

  test("#given no session state deps (legacy wiring) #when system transform runs #then ultrawork message injected", async () => {
    // given — handler constructed without the third parameter (legacy
    // signature): no session-type filtering, injection proceeds
    // when
    const systemPrompt = await renderSystemPrompt("any-session-id", undefined)

    // then
    expect(systemPrompt.includes(ULTRAWORK_INSTRUCTION_MARKER)).toBe(true)
  })
})
