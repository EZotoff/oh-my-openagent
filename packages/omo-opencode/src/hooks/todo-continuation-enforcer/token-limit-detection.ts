import { isRetryableModelError } from "../../shared/model-error-classifier"

const TOKEN_LIMIT_FALLBACK_PATTERNS = [
  "prompt is too long",
  "is too long",
  "context_length_exceeded",
  "token limit",
  "context length",
  "too many tokens",
]

const REQUEST_TOKEN_SCOPE_PHRASES = [
  "tokens in request",
  "input tokens",
  "prompt tokens",
  "context tokens",
]

const REQUEST_TOKEN_COMPARISON_PHRASES = [
  "more than",
  "exceeds",
  "exceeded",
  "greater than",
  "over",
]

const REQUEST_TOKEN_MAX_PHRASES = [
  "max tokens",
  "maximum tokens",
  "tokens allowed",
]

function isRequestTokenOverflowMessage(message: string): boolean {
  const lower = message.toLowerCase()
  const scopeIdx = REQUEST_TOKEN_SCOPE_PHRASES.findIndex((p) => lower.includes(p))
  if (scopeIdx === -1) return false
  const comparisonIdx = REQUEST_TOKEN_COMPARISON_PHRASES.findIndex((p) => lower.includes(p))
  if (comparisonIdx === -1) return false
  return REQUEST_TOKEN_MAX_PHRASES.some((p) => lower.includes(p))
}

const TOKEN_LIMIT_ERROR_NAMES = new Set([
  "contextlengtherror",
  "context_length_exceeded",
])

export function isTokenLimitError(error: { name?: string; message?: string } | undefined): boolean {
  if (!error) return false

  const isRetryable = isRetryableModelError({
    name: error.name,
    message: error.message,
  })

  if (!isRetryable && error.name) {
    const errorNameLower = error.name.toLowerCase()
    if (TOKEN_LIMIT_ERROR_NAMES.has(errorNameLower)) {
      return true
    }
  }

  if (error.message) {
    if (isRequestTokenOverflowMessage(error.message)) return true
    const lower = error.message.toLowerCase()
    return TOKEN_LIMIT_FALLBACK_PATTERNS.some((pattern) => lower.includes(pattern))
  }

  return false
}
