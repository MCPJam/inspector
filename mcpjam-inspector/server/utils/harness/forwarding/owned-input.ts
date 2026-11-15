import { HostedElicitationBridge } from "../../../routes/web/hosted-elicitation.js";
import { getConvexBearerForDelegation } from "../../v1-convex-token.js";
import {
  createHarnessInputHost,
  harnessElicitationModes,
} from "../input-host.js";

export async function forwardingInputHost(args: {
  credential:
    | { bearer: string }
    | { externalId: string; organizationId: string };
  projectId: string;
  chatSessionId?: string | null;
  serverId: string;
  capabilities: unknown;
  signal: AbortSignal;
  onInput?: () => void;
}) {
  const modes = harnessElicitationModes(args.capabilities);
  if (!modes.length) return undefined;
  if (!args.chatSessionId)
    throw new Error("The original chat input scope is unavailable");
  const bridge = new HostedElicitationBridge({
    convexBearer:
      "bearer" in args.credential
        ? args.credential.bearer
        : await getConvexBearerForDelegation(
            args.credential.externalId,
            args.credential.organizationId,
          ),
    projectId: args.projectId,
    chatSessionId: args.chatSessionId,
    serverNamesById: {},
    abortSignal: args.signal,
    delivery: "owned-chat-query",
  });
  return {
    host: createHarnessInputHost({
      allowedServerIds: new Set([args.serverId]),
      modes,
      handle: (request, signal) => {
        args.onInput?.();
        return bridge.callback(request, signal);
      },
      signal: args.signal,
    }),
    dispose: () => bridge.dispose(),
  };
}
