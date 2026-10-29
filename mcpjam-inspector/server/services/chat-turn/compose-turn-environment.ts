import { shouldUseLocalHarness } from "../../utils/harness/local/run-resources.js";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { externalAccountCredentialFor } from "../../../shared/external-credential-selection.js";
import { fetchHostRuntimeConfig } from "../../utils/host-runtime-config.js";
import { resolvePlaygroundCredentialEnvironment } from "../../utils/harness/playground-box.js";
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
  bearer: string;
  signal?: AbortSignal;
}): Promise<{ environmentId: string; harness: string | null }> {
  try {
    const hostId =
      args.hostId ??
      (
        await args.client.mutation(ensureClient, {
          projectId: args.projectId,
          themeMode: "light",
          purpose: "chat",
        })
      ).hostId;
    const runtime = await fetchHostRuntimeConfig({
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
    if (
      externalAccountCredentialFor(harness) &&
      !(await shouldUseLocalHarness(
        harness ?? undefined,
        args.bearer,
        args.projectId,
      ))
    ) {
      const credential = await resolvePlaygroundCredentialEnvironment({
        projectId: args.projectId,
        hostId,
        bearer: args.bearer,
        harnessId: harness!,
        chat: true,
      });
      if (!credential.ok)
        throw new WebRouteError(
          credential.status,
          credential.status === 502
            ? ErrorCode.SERVER_UNREACHABLE
            : ErrorCode.CONFLICT,
          credential.message,
          { reason: "EXTERNAL_ACCOUNT_CREDENTIAL_UNAVAILABLE" },
        );
      return { environmentId: credential.environmentId, harness };
    }
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
