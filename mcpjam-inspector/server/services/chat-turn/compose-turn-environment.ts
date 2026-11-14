import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  fetchHostRuntimeConfig,
  type HostRuntimeConfig,
} from "../../utils/host-runtime-config.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { translateEnvironmentRuntimeError } from "../environments/runtime.js";

const ensureClient = makeFunctionReference<
  "mutation",
  {
    projectId: string;
    themeMode: "light";
    purpose: "chat";
  },
  { hostId: string }
>("projectClients:ensureProjectClient");
const ensureEnvironment = makeFunctionReference<
  "mutation",
  {
    projectId: string;
    hostId: string;
    serverSelection: { mode: "none" };
    purpose: "chat";
  },
  { environment: { environmentId: string } }
>("projectEnvironments:ensureAdhocEnvironment");

/** Dedupe by composition only; model, selected servers and tools remain turn inputs. */
export async function composeTurnEnvironment(args: {
  client: ConvexHttpClient;
  projectId: string;
  hostId?: string;
  preparedHost?: { hostId: string; config: HostRuntimeConfig };
  bearer: string;
  signal?: AbortSignal;
}): Promise<{ environmentId: string; harness: string | null }> {
  try {
    const hostId =
      args.preparedHost?.hostId ??
      args.hostId ??
      (
        await args.client.mutation(ensureClient, {
          projectId: args.projectId,
          themeMode: "light",
          purpose: "chat",
        })
      ).hostId;
    const runtime = args.preparedHost
      ? { ok: true as const, config: args.preparedHost.config }
      : await fetchHostRuntimeConfig({
          hostId,
          bearer: args.bearer,
          signal: args.signal,
        });
    if (!runtime.ok) {
      const status =
        runtime.status >= 500 ? 502 : runtime.status === 401 ? 401 : 404;
      throw new WebRouteError(
        status,
        status === 502
          ? ErrorCode.SERVER_UNREACHABLE
          : status === 401
            ? ErrorCode.UNAUTHORIZED
            : ErrorCode.NOT_FOUND,
        `Couldn't load host "${hostId}". ${runtime.error}`,
        { reason: "HOST_UNRESOLVED", hostId },
      );
    }
    const harness = runtime.config.agentLoop ?? runtime.config.harness ?? null;
    const result = await args.client.mutation(ensureEnvironment, {
      projectId: args.projectId,
      hostId,
      serverSelection: { mode: "none" },
      purpose: "chat",
    });
    return { environmentId: result.environment.environmentId, harness };
  } catch (error) {
    throw translateEnvironmentRuntimeError(error);
  }
}
