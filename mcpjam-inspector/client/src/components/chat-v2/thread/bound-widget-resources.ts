import {
  readRetainedResourceSource,
  retainedResourceProofSchema,
  type RetainedResourceProof,
} from "@/shared/retained-app-resources";
import { useEffect, useMemo } from "react";
import { z } from "zod";
import type { WidgetHost } from "@mcpjam/widget-react";
import { authFetch } from "@/lib/session-token";
import { HOSTED_HARNESS_INPUT_VERSION } from "@/shared/hosted-elicitation";
import {
  readMcpWidgetContext,
  type McpWidgetExecutionContext,
} from "@/shared/mcp-tool-origin-metadata";
import { withBoundAppResources } from "../../host-workspace/model-app-resources";
import { parseAppResponse } from "../../host-workspace/thread-app-api";

/** A bound App never falls back to the currently selected account. */
export function useBoundWidgetResources(
  context?: McpWidgetExecutionContext | RetainedResourceProof,
) {
  const key = JSON.stringify(context);
  const binding = useMemo(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    const parsed: unknown = JSON.parse(key);
    const widget = readMcpWidgetContext({ mcpjam: { widgetContext: parsed } });
    const proof = retainedResourceProofSchema
      .extend({ signature: z.string() })
      .safeParse(parsed);
    const source = proof.success
      ? readRetainedResourceSource(proof.data.claim.output)
      : undefined;
    return widget || (source && proof.success)
      ? {
          context: widget ?? (proof.success ? proof.data : undefined),
          serverId: widget?.owner.serverId ?? source?.owner.serverId ?? "",
          controller,
          mounted: true,
        }
      : undefined;
  }, [key]);
  useEffect(() => {
    if (!binding) return;
    binding.mounted = true;
    return () => {
      binding.mounted = false;
      queueMicrotask(() => {
        if (!binding.mounted) binding.controller.abort();
      });
    };
  }, [binding]);
  return useMemo(() => {
    if (!binding?.context) return undefined;
    const { context, controller, serverId } = binding;
    const send = async (operation: object, signal: AbortSignal) => {
      const response = await authFetch(
        "/api/web/harness-forwarding/widget-resources",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mcpjam-harness-input-version": String(
              HOSTED_HARNESS_INPUT_VERSION,
            ),
          },
          body: JSON.stringify({ context, operation }),
          signal,
        },
      );
      const parsed = await parseAppResponse(response, signal);
      if (!response.ok)
        throw new Error(
          "This App resource is no longer available in the current chat.",
        );
      return parsed.value;
    };
    return (host: WidgetHost): WidgetHost => {
      const bound = withBoundAppResources(
        host,
        host,
        true,
        serverId,
        send,
        controller.signal,
      );
      return {
        ...bound,
        services: {
          ...bound.services,
          fetchWidgetContent: async (request) => {
            if (request.serverId !== serverId)
              throw new Error("App resource changed");
            return z
              .object({ html: z.string() })
              .passthrough()
              .parse(
                await send(
                  { method: "widget/content", request },
                  controller.signal,
                ),
              );
          },
        },
      };
    };
  }, [binding]);
}
