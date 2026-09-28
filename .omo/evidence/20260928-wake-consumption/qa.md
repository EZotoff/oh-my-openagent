# Wake consumption QA (2026-09-28)

## Tested

- Read-only OpenCode SQLite inspection of session `ses_f3f3c299cffelMU4l7kMsflzXA` for wake `e59cc5b7-a61a-4c8b-a792-205366155c4d`; no server was started or restarted.
- `bun test packages/omo-opencode/src/features/background-agent/parent-wake-watchdog.test.ts packages/omo-opencode/src/features/background-agent/wake-journal.test.ts packages/omo-opencode/src/features/background-agent/parent-wake-part-event-regression.test.ts`
- `bun run typecheck`; `bun run build`; checked `dist/index.js` for the changed verification and duplicate-dispatch paths.
- `bun test packages/omo-opencode/src/features/background-agent` (759 tests).
- Final targeted run including the polling regression: 31 pass, 0 fail (4 files).

## Observed

- The noReply wake's persisted user message is `msg_0cee1e435001lxrBLbe0Mn7s6q` (1790177305653). Later assistant `msg_0cee5b852001A5q3fYm3dsRPc5` (1790177556562) has parentID `msg_0cee5b8190018ErUU2rzJboqdu`, **not** the wake message. Subsequent session activity does not establish exact-wake output.
- The negative test was red before the fix: unrelated assistant output changed `dispatched-awaiting-output` to `consumed`. After the fix, 16 targeted tests passed including exact-output consumption, unrelated-output preservation, and startup-sweep identity filtering.
- Build and typecheck completed successfully; both changed code paths appear in `dist/index.js`. Live DB was inspected read-only, so its wake files and session count were not modified by QA.
- Background-agent suite: 753 pass, 6 fail. All six surviving failures assert old lowercase/long-form agent names against the current display-name normalization (`Sisyphus`, `Sisyphus-Junior`, `Hephaestus`). Two initially failing "no extra session.messages fetch" cases passed after the no-pending-wake guard was added.

## Scope and limits

The real persisted session confirms why noReply continuation alone cannot prove identity. The tests exercise the production notifier and journal against SDK-shaped messages on disk; they do not prove the newly built bundle was loaded by the running server. Service restarts and live wake-file writes were explicitly excluded by the task. No runtime-loaded or end-to-end behavior claim is made.
