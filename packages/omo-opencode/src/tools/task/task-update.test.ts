import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { TaskObject } from "./types"
import { createTaskUpdateTool } from "./task-update"

const TEST_SESSION_ID = "test-session-123"
const TEST_ABORT_CONTROLLER = new AbortController()
const TEST_CONTEXT = {
  sessionID: TEST_SESSION_ID,
  messageID: "test-message-123",
  agent: "test-agent",
  abort: TEST_ABORT_CONTROLLER.signal,
}

describe("task_update tool", () => {
  let tool: ReturnType<typeof createTaskUpdateTool>
  let testDir = ""

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "omo-task-update-"))
    tool = createTaskUpdateTool({
      sisyphus: {
        tasks: {
          storage_path: testDir,
        },
      },
    })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe("update action", () => {
    test("updates task subject when provided", async () => {
      //#given
      const taskId = "T-test-123"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Original subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        subject: "Updated subject",
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveProperty("task")
      expect(result.task.subject).toBe("Updated subject")
      expect(result.task.description).toBe("Test description")
    })

    test("updates task description when provided", async () => {
      //#given
      const taskId = "T-test-124"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Original description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        description: "Updated description",
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.description).toBe("Updated description")
    })

    test("updates task status when provided", async () => {
      //#given
      const taskId = "T-test-125"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        status: "in_progress" as const,
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveProperty("task")
      expect(result.task.status).toBe("in_progress")
    })

    test("additively appends to blocks array without replacing", async () => {
      //#given
      const taskId = "T-test-126"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: ["T-existing-1"],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        addBlocks: ["T-new-1", "T-new-2"],
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.blocks).toContain("T-existing-1")
      expect(result.task.blocks).toContain("T-new-1")
      expect(result.task.blocks).toContain("T-new-2")
      expect(result.task.blocks.length).toBe(3)
    })

    test("avoids duplicate blocks when adding", async () => {
      //#given
      const taskId = "T-test-127"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: ["T-existing-1"],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        addBlocks: ["T-existing-1", "T-new-1"],
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.blocks).toContain("T-existing-1")
      expect(result.task.blocks).toContain("T-new-1")
      expect(result.task.blocks.length).toBe(2)
    })

    test("additively appends to blockedBy array without replacing", async () => {
      //#given
      const taskId = "T-test-128"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: ["T-blocker-1"],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        addBlockedBy: ["T-blocker-2", "T-blocker-3"],
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.blockedBy).toContain("T-blocker-1")
      expect(result.task.blockedBy).toContain("T-blocker-2")
      expect(result.task.blockedBy).toContain("T-blocker-3")
      expect(result.task.blockedBy.length).toBe(3)
    })

    test("merges metadata without replacing entire object", async () => {
      //#given
      const taskId = "T-test-129"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        metadata: {
          priority: "high",
          assignee: "alice",
        },
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        metadata: {
          priority: "low",
          tags: ["bug"],
        },
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.metadata.priority).toBe("low")
      expect(result.task.metadata.assignee).toBe("alice")
      expect(result.task.metadata.tags).toEqual(["bug"])
    })

    test("deletes metadata keys when set to null", async () => {
      //#given
      const taskId = "T-test-130"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        metadata: {
          priority: "high",
          assignee: "alice",
          tags: ["bug"],
        },
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        metadata: {
          assignee: null,
        },
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.metadata.priority).toBe("high")
      expect(result.task.metadata.assignee).toBeUndefined()
      expect(result.task.metadata.tags).toEqual(["bug"])
    })

    test("updates activeForm when provided", async () => {
      //#given
      const taskId = "T-test-131"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        activeForm: "implementing feature X",
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.activeForm).toBe("implementing feature X")
    })

    test("updates owner when provided", async () => {
      //#given
      const taskId = "T-test-132"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        owner: "sisyphus",
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.owner).toBe("sisyphus")
    })

    test("returns error when task not found", async () => {
      //#given
      const args = {
        id: "T-nonexistent",
      }

      //#when
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveProperty("error")
      expect(result.error).toBe("task_not_found")
    })

    test("returns error for invalid task ID format", async () => {
      //#given
      const args = {
        id: "invalid-id",
      }

      //#when
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveProperty("error")
      expect(result.error).toBe("invalid_task_id")
    })

    test("persists changes to file storage", async () => {
      //#given
      const taskId = "T-test-133"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Original subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        subject: "Updated subject",
      }
      await tool.execute(args, TEST_CONTEXT)

      //#then
      const savedContent = await Bun.file(taskPath).text()
      const savedTask = JSON.parse(savedContent)
      expect(savedTask.subject).toBe("Updated subject")
    })

    test("updates multiple fields in single call", async () => {
      //#given
      const taskId = "T-test-134"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Original subject",
        description: "Original description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: TEST_SESSION_ID,
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))

      //#when
      const args = {
        id: taskId,
        subject: "New subject",
        description: "New description",
        status: "in_progress" as const,
        owner: "alice",
      }
      const resultStr = await tool.execute(args, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.task.subject).toBe("New subject")
      expect(result.task.description).toBe("New description")
      expect(result.task.status).toBe("in_progress")
      expect(result.task.owner).toBe("alice")
    })
  })

  describe("no-op and repeat protection", () => {
    test("second identical status update is a no-op that skips the write", async () => {
      //#given
      const taskId = "T-test-noop-1"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: "sess-noop-1",
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))
      const ctx = { ...TEST_CONTEXT, sessionID: "sess-noop-1" }
      const args = { id: taskId, status: "in_progress" as const }

      //#when
      const first = JSON.parse(await tool.execute(args, ctx))
      const mtimeAfterFirst = (await Bun.file(taskPath).stat()).mtimeMs
      const second = JSON.parse(await tool.execute(args, ctx))
      const mtimeAfterSecond = (await Bun.file(taskPath).stat()).mtimeMs

      //#then
      expect(first.task.status).toBe("in_progress")
      expect(first.noop).toBeUndefined()
      expect(second.noop).toBe(true)
      expect(second.task.status).toBe("in_progress")
      expect(mtimeAfterSecond).toBe(mtimeAfterFirst)
    })

    test("third identical update is blocked with repeated_identical_call", async () => {
      //#given
      const taskId = "T-test-noop-2"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: "sess-noop-2",
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))
      const ctx = { ...TEST_CONTEXT, sessionID: "sess-noop-2" }
      const args = { id: taskId, status: "in_progress" as const }

      //#when
      const first = JSON.parse(await tool.execute(args, ctx))
      const second = JSON.parse(await tool.execute(args, ctx))
      const third = JSON.parse(await tool.execute(args, ctx))

      //#then
      expect(first.noop).toBeUndefined()
      expect(second.noop).toBe(true)
      expect(third.error).toBe("repeated_identical_call")
    })

    test("different args reset the repeat counter", async () => {
      //#given
      const taskId = "T-test-noop-3"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: "sess-noop-3",
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))
      const ctx = { ...TEST_CONTEXT, sessionID: "sess-noop-3" }
      const statusArgs = { id: taskId, status: "in_progress" as const }

      //#when
      await tool.execute(statusArgs, ctx)
      const subjectResult = JSON.parse(
        await tool.execute({ id: taskId, subject: "New subject" }, ctx),
      )
      const statusAgain = JSON.parse(await tool.execute(statusArgs, ctx))

      //#then
      expect(subjectResult.task.subject).toBe("New subject")
      expect(statusAgain.error).toBeUndefined()
      expect(statusAgain.noop).toBe(true)
    })

    test("lock failures do not count toward the repeat counter and carry retry guidance", async () => {
      //#given
      const taskId = "T-test-noop-4"
      const taskPath = join(testDir, `${taskId}.json`)
      const initialTask: TaskObject = {
        id: taskId,
        subject: "Test subject",
        description: "Test description",
        status: "pending",
        blocks: [],
        blockedBy: [],
        threadID: "sess-noop-4",
      }
      await Bun.write(taskPath, JSON.stringify(initialTask))
      const ctx = { ...TEST_CONTEXT, sessionID: "sess-noop-4" }
      const args = { id: taskId, status: "in_progress" as const }
      // Hold the lock with a fresh timestamp (not stale)
      await Bun.write(join(testDir, ".lock"), JSON.stringify({ id: "other", timestamp: Date.now() }))

      //#when
      const locked = JSON.parse(await tool.execute(args, ctx))
      await Bun.write(join(testDir, ".lock"), JSON.stringify({ id: "other", timestamp: Date.now() }))
      const lockedAgain = JSON.parse(await tool.execute(args, ctx))
      // Release the lock; the two failed attempts must not have counted
      const { unlinkSync } = await import("fs")
      unlinkSync(join(testDir, ".lock"))
      const unlocked = JSON.parse(await tool.execute(args, ctx))

      //#then
      expect(locked.error).toBe("task_lock_unavailable")
      expect(locked.retryable).toBe(true)
      expect(locked.message).toContain("retry")
      expect(lockedAgain.error).toBe("task_lock_unavailable")
      expect(unlocked.error).toBeUndefined()
      expect(unlocked.noop).toBeUndefined()
    })
  })
})
