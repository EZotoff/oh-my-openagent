import type { DefaultModeConfig } from "../config/schema/default-mode"
import { reconcileSisyphusRuntimePrompt } from "../agents/sisyphus-runtime-prompt-reconciler"

const ULTRAWORK_MODE_TAG = "<ultrawork-mode>"

/**
 * Session-type awareness for the default-mode injection branch. Optional on
 * purpose: tests and legacy wiring may construct the handler without it, in
 * which case injection behaves exactly as before (no session filtering).
 */
export interface SystemTransformSessionState {
  isSubagentSession(sessionID: string): boolean
  getMainSessionID(): string | undefined
}

export function createSystemTransformHandler(
  defaultMode?: DefaultModeConfig,
  getUltraworkMessage?: (agentName?: string, modelID?: string) => string,
  sessionState?: SystemTransformSessionState,
): (
  input: { sessionID?: string; model: { id: string; providerID: string; [key: string]: unknown } },
  output: { system: string[] },
) => Promise<void> {
  return async (input, output): Promise<void> => {
    // The Sisyphus prompt body is model-family-specific and baked at registration
    // from the *configured* model in oh-my-openagent.jsonc. This per-request hook
    // is the only seam that knows the model actually selected at runtime, so
    // rebuild the whole body for the runtime model family here (issue #5297).
    reconcileSisyphusRuntimePrompt(output.system, input.model?.id)

    if (!defaultMode?.ultrawork || !getUltraworkMessage) return

    // Fork patch omo--ultrawork-subagent-guard: default-mode ultrawork injection
    // is main-session only. task()-spawned children (subagents, category
    // executors, background tasks) must not receive the ultrawork bundle —
    // mirrors the keyword-detector guard in hooks/keyword-detector/hook.ts
    // (subagentSessions skip + non-main-session skip).
    if (sessionState && input.sessionID) {
      if (sessionState.isSubagentSession(input.sessionID)) return
      const mainSessionID = sessionState.getMainSessionID()
      if (mainSessionID && input.sessionID !== mainSessionID) return
    }

    // Avoid re-injecting if the ultrawork prompt is already in the system prompt
    // (e.g. after compaction the system prompt is rebuilt and this hook fires again)
    if (output.system.some((part) => part.includes(ULTRAWORK_MODE_TAG))) return

    const modelID = input.model?.id
    const ultraworkMessage = getUltraworkMessage("sisyphus", modelID)
    if (!ultraworkMessage) return

    output.system.push(ultraworkMessage)
  }
}
