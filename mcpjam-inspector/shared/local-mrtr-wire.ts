import { z } from "zod";
import type { MrtrKeyAnswer } from "./local-mrtr";

export const LOCAL_MRTR_PROTOCOL = "mcpjam-mrtr.v1";
export const LOCAL_MRTR_CREDENTIAL_PREFIX = "mcpjam-session.";
/** Aggregate local form round/answer policy, independent of private state hydration. */
export const LOCAL_MRTR_MAX_FRAME_BYTES = 30 * 1024 * 1024;

export function localMrtrProtocols(token: string): string[] {
  return [LOCAL_MRTR_PROTOCOL, `${LOCAL_MRTR_CREDENTIAL_PREFIX}${token}`];
}

/** Only a public first protocol may be negotiated back to the browser. */
export function localMrtrCredential(header: string | undefined): string | null {
  const protocols = header?.split(",").map((value) => value.trim()) ?? [];
  if (protocols.length !== 2 || protocols[0] !== LOCAL_MRTR_PROTOCOL)
    return null;
  const credential = protocols[1];
  if (!credential.startsWith(LOCAL_MRTR_CREDENTIAL_PREFIX)) return null;
  const token = credential.slice(LOCAL_MRTR_CREDENTIAL_PREFIX.length);
  return /^[A-Za-z0-9_-]{24,}$/.test(token) ? token : null;
}

// Parsing a dictionary must preserve every server-selected key, including __proto__.
const record = z.custom<Record<string, unknown>>(
  (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value),
);
const answer = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  content: record.optional(),
});

export const localMrtrResponseSchema = z.object({
  type: z.literal("respond"),
  requestId: z.string().min(1).max(128),
  opId: z.string().min(1),
  roundKey: z.string().min(1),
  responses: z.custom<Record<string, MrtrKeyAnswer>>((value) => {
    const parsed = record.safeParse(value);
    return (
      parsed.success &&
      Object.values(parsed.data).every(
        (entry) => answer.safeParse(entry).success,
      )
    );
  }),
});

const round = z.object({
  opId: z.string(),
  roundKey: z.string(),
  round: z.number().int().nonnegative(),
  serverId: z.string().optional(),
  timestamp: z.string(),
  requests: z.array(
    z.object({
      key: z.string(),
      mode: z.enum(["form", "url"]),
      message: z.string(),
      requestedSchema: record.optional(),
      pluginForm: z.boolean().optional(),
      url: z.string().optional(),
    }),
  ),
});

export const localMrtrMessageSchema = z.discriminatedUnion("type", [
  round.extend({ type: z.literal("mrtr_input_request") }),
  z.object({
    type: z.enum(["mrtr_input_complete", "mrtr_input_cancelled"]),
    opId: z.string(),
    roundKey: z.string().optional(),
  }),
  z.object({ type: z.literal("snapshot_start") }),
  z.object({ type: z.literal("snapshot_end") }),
  z.object({ type: z.literal("keepalive") }),
  z.object({
    type: z.literal("response"),
    requestId: z.string(),
    result: z.union([
      z.object({ ok: z.literal(true) }),
      z.object({
        ok: z.literal(false),
        status: z.union([z.literal(400), z.literal(404)]),
        error: z.string(),
      }),
    ]),
  }),
]);

export type LocalMrtrMessage = z.infer<typeof localMrtrMessageSchema>;
export type LocalMrtrEvent = Extract<
  LocalMrtrMessage,
  {
    type: "mrtr_input_request" | "mrtr_input_complete" | "mrtr_input_cancelled";
  }
>;
