import { z } from "zod";
import { makeFunctionReference } from "convex/server";

export type AppToolCallScope = {
  projectId: string;
  chatSessionId: string;
  turnId: string;
  toolCallId: string;
  alias: string;
  bridgeId: string;
  serverId: string;
  parentToolCallId: string;
  rawName: string;
};
export interface AppToolInvocationEvent {
  id: string;
  chatSessionId: string;
  alias: string;
  bridgeId: string;
  expiresAt: number;
}
export interface ClaimedAppTool {
  projectId: string;
  expiresAt: number;
  inputJson: string;
  alias: string;
  bridgeId: string;
  chatSessionId: string;
  serverId: string;
  parentToolCallId: string;
  rawName: string;
}
export const appToolInvocations = {
  create: makeFunctionReference<
    "mutation",
    AppToolCallScope & { inputJson: string },
    { id: string; expiresAt: number }
  >("appToolInvocations:create"),
  claim: makeFunctionReference<
    "mutation",
    { id: string; bridgeId: string; claim: string },
    ClaimedAppTool | null
  >("appToolInvocations:claim"),
  complete: makeFunctionReference<
    "mutation",
    { id: string; claim: string; resultJson: string },
    null
  >("appToolInvocations:complete"),
  read: makeFunctionReference<
    "query",
    { id: string },
    { state: string; resultJson?: string }
  >("appToolInvocations:read"),
  finish: makeFunctionReference<
    "mutation",
    { id: string; consumed: boolean },
    null
  >("appToolInvocations:finish"),
};
const eventSchema = z.object({
  type: z.literal("data-harness-app-tool"),
  data: z.object({
    id: z.string().min(1).max(256),
    chatSessionId: z.string().min(1).max(256),
    alias: z.string().regex(/^app_[a-z0-9]{8}$/i),
    bridgeId: z.string().min(1).max(128),
    expiresAt: z.number().finite(),
  }),
});
export function appToolInvocationEvent(
  part: unknown,
): AppToolInvocationEvent | null {
  const parsed = eventSchema.safeParse(part);
  return parsed.success ? parsed.data.data : null;
}
