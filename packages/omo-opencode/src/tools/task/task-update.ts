import type { PluginInput } from "@opencode-ai/plugin";
import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { join } from "path";
import type { OhMyOpenCodeConfig } from "../../config/schema";
import { TaskObjectSchema, TaskUpdateInputSchema } from "./types";
import {
  getTaskDir,
  readJsonSafe,
  writeJsonAtomic,
  acquireLockWithRetry,
} from "../../features/claude-tasks/storage";
import { syncTaskTodoUpdate } from "./todo-sync";

const TASK_ID_PATTERN = /^T-[A-Za-z0-9-]+$/;

function parseTaskId(id: string): string | null {
  if (!TASK_ID_PATTERN.test(id)) return null;
  return id;
}

const NOOP_MESSAGE =
  "NO-OP: no fields changed. The task is already in the requested state — never repeat an identical task_update; proceed with the actual work."

const REPEAT_LIMIT = 2

// Tracks the last completed task_update per session to hard-stop degenerate
// identical-call loops (2026-10-09 incident: 208 identical in_progress updates).
const repeatTracker = new Map<string, { hash: string; count: number }>()

function hashUpdateArgs(validatedArgs: Record<string, unknown>): string {
  const keys = Object.keys(validatedArgs).sort()
  return JSON.stringify(keys.map((key) => [key, validatedArgs[key]]))
}

function recordCompletedUpdate(sessionID: string, hash: string): void {
  const prev = repeatTracker.get(sessionID)
  repeatTracker.set(sessionID, {
    hash,
    count: prev && prev.hash === hash ? prev.count + 1 : 1,
  })
}

export function createTaskUpdateTool(
  config: Partial<OhMyOpenCodeConfig>,
  ctx?: PluginInput,
): ToolDefinition {
   return tool({
     description: `Update an existing task with new values.

Supports updating: subject, description, status, activeForm, owner, metadata.
For blocks/blockedBy: use addBlocks/addBlockedBy to append (additive, not replacement).
For metadata: merge with existing, set key to null to delete.
Syncs to OpenCode Todo API after update.
Re-asserting an unchanged value is a NO-OP and returns {noop:true} — never repeat an identical
task_update; if you receive noop or {error:'repeated_identical_call'}, the task state is already
set and you must proceed with the actual work.

**IMPORTANT - Dependency Management:**
Use \`addBlockedBy\` to declare dependencies on other tasks.
Properly managed dependencies enable maximum parallel execution.`,
     args: {
      id: tool.schema.string().describe("Task ID (required)"),
      subject: tool.schema.string().optional().describe("Task subject"),
      description: tool.schema.string().optional().describe("Task description"),
      status: tool.schema
        .enum(["pending", "in_progress", "completed", "deleted"])
        .optional()
        .describe("Task status"),
      activeForm: tool.schema
        .string()
        .optional()
        .describe("Active form (present continuous)"),
      owner: tool.schema
        .string()
        .optional()
        .describe("Task owner (agent name)"),
      addBlocks: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Task IDs to add to blocks (additive, not replacement)"),
      addBlockedBy: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Task IDs to add to blockedBy (additive, not replacement)"),
      metadata: tool.schema
        .record(tool.schema.string(), tool.schema.unknown())
        .optional()
        .describe("Task metadata to merge (set key to null to delete)"),
    },
    execute: async (args, context) => {
      return handleUpdate(args, config, ctx, context);
    },
  });
}

async function handleUpdate(
  args: Record<string, unknown>,
  config: Partial<OhMyOpenCodeConfig>,
  ctx: PluginInput | undefined,
  context: { sessionID: string },
): Promise<string> {
  try {
    const validatedArgs = TaskUpdateInputSchema.parse(args);
    const taskId = parseTaskId(validatedArgs.id);
    if (!taskId) {
      return JSON.stringify({ error: "invalid_task_id" });
    }

    const argsHash = hashUpdateArgs(validatedArgs)
    const prevCall = repeatTracker.get(context.sessionID)
    if (prevCall && prevCall.hash === argsHash && prevCall.count >= REPEAT_LIMIT) {
      return JSON.stringify({
        error: "repeated_identical_call",
        message: `Identical task_update already completed ${prevCall.count}x in this session. This call is blocked until the arguments change — proceed with the actual work instead of re-issuing it.`,
      })
    }

    const taskDir = getTaskDir(config)
    const lock = await acquireLockWithRetry(taskDir)

    if (!lock.acquired) {
      return JSON.stringify({
        error: "task_lock_unavailable",
        retryable: true,
        message: "Task store is locked by another session (transient). Safe to retry once with identical arguments, or proceed without updating.",
      })
    }

    try {
      const taskPath = join(taskDir, `${taskId}.json`);
      const task = readJsonSafe(taskPath, TaskObjectSchema);

      if (!task) {
        return JSON.stringify({ error: "task_not_found" });
      }

      const before = JSON.stringify(task)

      if (validatedArgs.subject !== undefined) {
        task.subject = validatedArgs.subject;
      }
      if (validatedArgs.description !== undefined) {
        task.description = validatedArgs.description;
      }
      if (validatedArgs.status !== undefined) {
        task.status = validatedArgs.status;
      }
      if (validatedArgs.activeForm !== undefined) {
        task.activeForm = validatedArgs.activeForm;
      }
      if (validatedArgs.owner !== undefined) {
        task.owner = validatedArgs.owner;
      }

      const addBlocks = args.addBlocks as string[] | undefined;
      if (addBlocks) {
        task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      }

      const addBlockedBy = args.addBlockedBy as string[] | undefined;
      if (addBlockedBy) {
        task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
      }

      if (validatedArgs.metadata !== undefined) {
        task.metadata = { ...task.metadata, ...validatedArgs.metadata };
        Object.keys(task.metadata).forEach((key) => {
          if (task.metadata?.[key] === null) {
            delete task.metadata[key];
          }
        });
      }

      if (JSON.stringify(task) === before) {
        recordCompletedUpdate(context.sessionID, argsHash)
        return JSON.stringify({
          noop: true,
          task: TaskObjectSchema.parse(task),
          message: NOOP_MESSAGE,
        })
      }

      const validatedTask = TaskObjectSchema.parse(task)
      writeJsonAtomic(taskPath, validatedTask)

      await syncTaskTodoUpdate(ctx, validatedTask, context.sessionID)

      recordCompletedUpdate(context.sessionID, argsHash)

      return JSON.stringify({ task: validatedTask })
    } finally {
      lock.release();
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Required")) {
      return JSON.stringify({
        error: "validation_error",
        message: error.message,
      });
    }
    return JSON.stringify({ error: "internal_error" });
  }
}
