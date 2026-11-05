import {
  harnessNativeDiscoverySupport,
  type HarnessDiscoveryRoute,
} from "@/shared/harness-model-support";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/** Required discovery fails before provisioning; ordinary clients stay unchanged. */
export function assertNativeDiscovery(args: {
  required?: boolean;
  harnessId?: string;
  route?: HarnessDiscoveryRoute;
}): void {
  if (!args.required) return;
  const verdict =
    args.harnessId && args.route
      ? harnessNativeDiscoverySupport({
          harnessId: args.harnessId,
          route: args.route,
        })
      : undefined;
  if (verdict?.status === "supported") return;
  throw new WebRouteError(
    409,
    ErrorCode.CONFLICT,
    verdict?.reason ??
      "Native tool discovery requires a qualified harness execution route.",
    { reason: "native_discovery_unqualified" },
  );
}

/** A stored conversation requirement survives edits to its current client. */
export function enforceNativeDiscoverySessionPin(
  host: { requireNativeToolDiscovery?: boolean } | null | undefined,
  required?: boolean,
): void {
  if (!required) return;
  if (!host) assertNativeDiscovery({ required: true });
  else host.requireNativeToolDiscovery = true;
}
