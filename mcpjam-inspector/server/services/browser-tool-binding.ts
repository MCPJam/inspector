import { pageToolsFromObservation } from "../../shared/browser-page-tools";
import type {
  ObservationStateToken,
  WebMcpToolBinding,
} from "./browserd/protocol";

/** Pin a generic invocation to the registration whose origin was checked. */
export function observedToolBinding(args: {
  output: unknown;
  stateToken?: ObservationStateToken;
  bootId: string;
  toolKey: string;
  frameId?: string;
  origins: readonly string[];
}): WebMcpToolBinding {
  const candidates = pageToolsFromObservation(args.output).tools.filter(
    (tool) =>
      tool.name === args.toolKey &&
      (!args.frameId || tool.frameId === args.frameId),
  );
  const tool = candidates.length === 1 ? candidates[0] : undefined;
  if (!tool?.frameId || tool.registrationSeq === undefined || !args.stateToken)
    throw new Error(
      "stale_binding: observe one identifiable page tool before invoking it",
    );
  if (!tool.origin || !args.origins.includes(tool.origin))
    throw new Error(
      "origin_not_allowed: the page tool's frame is outside the session policy",
    );
  return {
    bootId: args.bootId,
    tabId: args.stateToken.tabId,
    navCounter: args.stateToken.navCounter,
    frameId: tool.frameId,
    registrationSeq: tool.registrationSeq,
  };
}
