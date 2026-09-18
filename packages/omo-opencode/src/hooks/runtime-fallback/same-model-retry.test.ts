import { afterEach, describe, expect, test } from "bun:test"

import { createSameModelRetryHelpers } from "./same-model-retry"
import { installRuntimeFallbackTestClock, restoreRuntimeFallbackTestClock } from "./test-timeout-clock.test-support"

describe("createSameModelRetryHelpers", () => {
  afterEach(() => {
    restoreRuntimeFallbackTestClock()
  })

  test("#given repeated terminal retryable errors #when retries are scheduled #then delays grow exponentially and cap at two minutes", async () => {
    // given
    const clock = installRuntimeFallbackTestClock(0)
    const attempts = new Map<string, number>()
    const timeouts = new Map<string, ReturnType<typeof setTimeout>>()
    const dispatchTimes: number[] = []
    const helpers = createSameModelRetryHelpers(attempts, timeouts, async () => {
      dispatchTimes.push(Date.now())
      return { accepted: true, status: "dispatched" }
    })

    // when
    for (let attempt = 0; attempt < 9; attempt += 1) {
      helpers.schedule("session-cap", "openai/gpt-5.4", undefined)
      await clock.advanceBy(attempt < 7 ? 2 ** attempt * 1000 : 120_000)
    }

    // then
    expect(dispatchTimes).toEqual([1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 127_000, 247_000, 367_000])
  })

  test("#given a same-model retry is already scheduled #when the same terminal error repeats #then only one dispatch occurs", async () => {
    // given
    const clock = installRuntimeFallbackTestClock(0)
    const attempts = new Map<string, number>()
    const timeouts = new Map<string, ReturnType<typeof setTimeout>>()
    let dispatchCount = 0
    const helpers = createSameModelRetryHelpers(attempts, timeouts, async () => {
      dispatchCount += 1
      return { accepted: true, status: "dispatched" }
    })

    // when
    helpers.schedule("session-duplicate", "openai/gpt-5.4", undefined)
    helpers.schedule("session-duplicate", "openai/gpt-5.4", undefined)
    await clock.advanceBy(1_000)

    // then
    expect(dispatchCount).toBe(1)
    expect(attempts.get("session-duplicate")).toBe(1)
  })

  test("#given a scheduled same-model retry #when the session is cleared #then the timer and backoff are cancelled", async () => {
    // given
    const clock = installRuntimeFallbackTestClock(0)
    const attempts = new Map<string, number>()
    const timeouts = new Map<string, ReturnType<typeof setTimeout>>()
    let dispatchCount = 0
    const helpers = createSameModelRetryHelpers(attempts, timeouts, async () => {
      dispatchCount += 1
      return { accepted: true, status: "dispatched" }
    })
    helpers.schedule("session-clear", "openai/gpt-5.4", undefined)

    // when
    helpers.clear("session-clear")
    await clock.advanceBy(1_000)

    // then
    expect(dispatchCount).toBe(0)
    expect(attempts.has("session-clear")).toBe(false)
    expect(timeouts.has("session-clear")).toBe(false)
  })
})
