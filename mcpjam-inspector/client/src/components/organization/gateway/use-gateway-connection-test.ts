/**
 * Runs a gateway's connection Test from wherever the connection's calls will
 * come from: MCPJam's servers (`testProviderConnection`, admins only) or this
 * Inspector's server (`/api/web/org-gateway-test`), since MCPJam's servers
 * never call a gateway set to run from each user's Inspector.
 */
import { useCallback } from "react";
import { useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { webPost } from "@/lib/apis/web/base";
import { convexErrMessage } from "@/lib/convex-error";
import type {
  GatewayApi,
  GatewayConnectionTestResult,
} from "@/shared/gateway-connection";
import type { GatewayTestResponse } from "./gateway-test-outcome";
import type { GatewayRuntimeLocation } from "./gateway-works-with";

type ProbeArgs = { baseUrl: string; secret?: string; apis?: GatewayApi[] };

const testProviderConnection = makeFunctionReference<
  "action",
  ProbeArgs & { organizationId: string; providerKey?: string },
  GatewayConnectionTestResult
>("organizationModelProviders:testProviderConnection");

export type GatewayTestRequest = ProbeArgs & {
  runtimeLocation: GatewayRuntimeLocation;
  /** A saved connection's key: the backend then tests with its stored key. */
  providerKey?: string;
};

export function useGatewayConnectionTest(
  organizationId: string,
): (request: GatewayTestRequest) => Promise<GatewayTestResponse> {
  const testFromBackend = useAction(testProviderConnection);
  return useCallback(
    async ({ runtimeLocation, providerKey, ...probe }) => {
      try {
        return runtimeLocation === "local"
          ? await webPost<ProbeArgs, GatewayConnectionTestResult>(
              "/api/web/org-gateway-test",
              probe,
            )
          : await testFromBackend({
              organizationId,
              ...(providerKey ? { providerKey } : {}),
              ...probe,
            });
      } catch (error) {
        return {
          error: convexErrMessage(error, "The test couldn't run. Try again."),
        };
      }
    },
    [organizationId, testFromBackend],
  );
}
