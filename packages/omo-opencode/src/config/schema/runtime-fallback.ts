import { z } from "zod"

export const RuntimeFallbackConfigSchema = z.object({
  /** Enable runtime fallback (default: false) */
  enabled: z.boolean().optional(),
  /** HTTP status codes that trigger fallback (default: [429, 500, 502, 503, 504]) */
  retry_on_errors: z.array(z.number()).optional(),
  /** Provider-native same-model retries to allow before failing over (default: 0 = fall back on first retry signal). OpenCode retries the same model with exponential backoff on retryable errors; each retry emits a session.status retry event with an incrementing attempt number. With retries_before_fallback=N, retry signals with attempt <= N are ignored (letting OpenCode retry the same model); the first signal with attempt > N aborts the retry loop and dispatches the fallback chain. */
  retries_before_fallback: z.number().min(0).max(10).optional(),
  /** Maximum fallback attempts per session (default: 3) */
  max_fallback_attempts: z.number().min(1).max(20).optional(),
  /** Cooldown in seconds before retrying a failed model (default: 60) */
  cooldown_seconds: z.number().min(0).optional(),
  /** Session-level timeout in seconds to advance fallback when provider hangs (default: 30). Set to 0 to disable timeout escalation and message.updated auto-retry signal detection. */
  timeout_seconds: z.number().min(0).optional(),
  /** Show toast notification when switching to fallback model (default: true) */
  notify_on_fallback: z.boolean().optional(),
  restore_primary_after_cooldown: z.boolean().optional(),
})

export type RuntimeFallbackConfig = z.infer<typeof RuntimeFallbackConfigSchema>
