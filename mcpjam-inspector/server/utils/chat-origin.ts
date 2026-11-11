// Mirrors mcpjam-backend `chatOriginValidator`. Required at every writer
// boundary so a new surface can't be added without explicitly choosing one.
// Backend still accepts undefined for historical-row compatibility; the
// inspector pins to the closed set. `swarm` is the journey-execution surface
// (single-host synthetic sessions launched by a project member).
export type ChatOrigin =
  | "playground"
  | "mcpjam_agent"
  | "scenario"
  | "eval"
  | "swarm"
  // Agent Playground turn route. Validator ships with backend PR 4; this
  // mirror must exist before anything emits `"api"`.
  | "api"
  // MCP Events trigger run (`services/events/executor.ts`): an unattended
  // turn fired by an event. Mirrors the backend validator's `event`.
  | "event";
