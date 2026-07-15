// The XAA state machine now lives in @mcpjam/sdk (browser-safe) so the CLI and
// the inspector share one engine. Re-exported here so the debug adapter and any
// stragglers keep their `@/lib/xaa/state-machine` import path.
export {
  createXAAStateMachine,
  CLIENT_SECRET_MASK,
} from "@mcpjam/sdk/browser";
