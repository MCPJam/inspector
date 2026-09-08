/**
 * The wire protocol between the host adapter and the in-sandbox bridge.
 *
 * Everything except the `start` payload comes from the shared
 * `@ai-sdk/harness` protocol — outbound events, transport frames, the inbound
 * command set, the `bridge-ready` line. Only the fields Codex's app-server
 * transport needs are added here.
 */
import {
  harnessV1BridgeInboundCommandSchemas,
  harnessV1BridgeOutboundMessageSchema,
  harnessV1BridgeReadySchema,
  harnessV1BridgeStartBaseSchema,
} from "@ai-sdk/harness";
import { z } from "zod/v4";

export const outboundMessageSchema = harnessV1BridgeOutboundMessageSchema;
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;

export const startMessageSchema = harnessV1BridgeStartBaseSchema.extend({
  /** Extra instructions, sent as `developerInstructions` so Codex keeps its own
   *  system prompt (see `app-server-protocol.ts`). */
  instructions: z.string().optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  webSearch: z.boolean().optional(),
  /** Layered over the rendered `config.toml` for this thread. */
  codexConfig: z.record(z.string(), z.unknown()).optional(),
  /** Resume signal: `thread/resume` instead of `thread/start`. */
  resumeThreadId: z.string().optional(),
  /** Force a fresh thread even when one is parked (the turn's configuration
   *  changed in a way a resumed thread would not pick up). */
  restartThread: z.boolean().optional(),
});
export type StartMessage = z.infer<typeof startMessageSchema>;

/*
 * There is deliberately no `compact` command here.
 *
 * `codex app-server` DOES expose manual compaction (`thread/compact/start`),
 * but the framework's bridge owns the socket and routes inbound frames through
 * a fixed switch with no default branch — an unrecognised `type` is silently
 * dropped, not rejected. A custom compact frame would therefore look like it
 * worked and do nothing, which is worse than not offering it. `doCompact`
 * throws `HarnessCapabilityUnsupportedError` instead, and Codex's own automatic
 * compaction is still observed and reported as a `compaction` stream part.
 */
export const inboundMessageSchema = z.discriminatedUnion("type", [
  startMessageSchema,
  ...harnessV1BridgeInboundCommandSchemas,
]);
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

export const bridgeReadySchema = harnessV1BridgeReadySchema;
