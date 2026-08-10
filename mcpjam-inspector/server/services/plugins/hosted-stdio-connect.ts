/**
 * The hosted stdio divert: turn one plugin `stdio` component into a remote
 * Streamable-HTTP endpoint `createAuthorizedManager` can connect to, or answer
 * `null` and leave hosted's refusal in place.
 *
 * A thin composition on purpose — read the configured spec, resolve the box,
 * ensure the runtime — so the connect seam in `routes/web/auth.ts` stays a
 * routing decision and every rule about verification, placement and admission
 * lives in `computer-stdio.ts`.
 *
 * `null` is the ONLY failure shape. Every reason a plugin cannot run hosted
 * ends at the same place (`toHttpConfig`'s `local_runtime_required` refusal),
 * and returning `null` rather than throwing keeps one server's plugin problem
 * from aborting a batch that other servers would have connected fine — while
 * still refusing this one.
 */
import { logger } from "../../utils/logger.js";
import {
  createPluginRuntimeConvexClient,
  readAuthorizedStdioLaunchSpec,
  type WorkosApiKeyActingAs,
} from "../../utils/local-server-resolver.js";
import { e2bPluginBoxConnector } from "../../utils/computers/plugin-box.js";
import {
  canColocatePluginStdio,
  ensurePluginStdioRuntime,
  needsPluginRoot,
  resolveColocatedPluginBox,
  type PluginBoxConnector,
} from "./computer-stdio.js";
import type { ExecutionScope } from "../../utils/execution-scope.js";

/** What the connect seam needs to build an `HttpServerConfig` for the shim. */
export interface PluginStdioHttpTarget {
  url: string;
  /** The shim's bearer. Goes on the wire and nowhere else. */
  token: string;
}

export async function resolvePluginStdioHttpTarget(args: {
  bearerToken: string;
  projectId: string;
  serverId: string;
  serverDisplayName: string;
  accessScope?: "project_member" | "chat_v2";
  chatboxId?: string;
  accessVersion?: number;
  workosApiKeyActingAs?: WorkosApiKeyActingAs;
  executionScope?: ExecutionScope;
  signal?: AbortSignal;
  /** Test seam for the vendor boundary; defaults to real E2B. */
  connect?: PluginBoxConnector;
}): Promise<PluginStdioHttpTarget | null> {
  if (!canColocatePluginStdio()) return null;

  try {
    const spec = await readAuthorizedStdioLaunchSpec({
      bearerToken: args.bearerToken,
      projectId: args.projectId,
      serverId: args.serverId,
      serverDisplayName: args.serverDisplayName,
      ...(args.accessScope ? { accessScope: args.accessScope } : {}),
      ...(args.chatboxId ? { chatboxId: args.chatboxId } : {}),
      ...(args.accessVersion !== undefined
        ? { accessVersion: args.accessVersion }
        : {}),
      ...(args.workosApiKeyActingAs
        ? { workosApiKeyActingAs: args.workosApiKeyActingAs }
        : {}),
    });

    // ORDINARY stdio servers stay refused. Only a plugin component — a config
    // still carrying the SDK's root placeholders — is a thing MCPJam knows how
    // to place inside a box: it comes with verified, content-addressed bytes
    // and a backend pin. An arbitrary user-authored command has neither, and
    // colocating it would turn "run a plugin" into "run anything in my VM".
    if (!needsPluginRoot(spec)) return null;

    // The plugin-runtime reads ride the Convex QUERY protocol (a user JWT via
    // setAuth), which the service-token acting-as exchange cannot authenticate
    // — a delegated caller's bearer is deliberately empty. Refuse rather than
    // run those reads unauthenticated.
    if (args.workosApiKeyActingAs) return null;

    const box = await resolveColocatedPluginBox({
      bearer: args.bearerToken,
      projectId: args.projectId,
      ...(args.executionScope ? { executionScope: args.executionScope } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!box) return null;

    const result = await ensurePluginStdioRuntime({
      client: createPluginRuntimeConvexClient(args.bearerToken),
      projectId: args.projectId,
      serverId: args.serverId,
      spec,
      box,
      connect: args.connect ?? e2bPluginBoxConnector,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!result.ok) {
      logger.info("[plugin-computer] hosted stdio divert declined", {
        serverId: args.serverId,
        reason: result.reason,
      });
      return null;
    }
    return { url: result.runtime.url, token: result.runtime.token };
  } catch (error) {
    logger.warn("[plugin-computer] hosted stdio divert failed", {
      serverId: args.serverId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
