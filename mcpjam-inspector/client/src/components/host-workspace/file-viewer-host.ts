import type { WidgetHost } from "@mcpjam/widget-react";
import type { ThreadAppHandle } from "./thread-app-api";
import type { createFileViewerServices } from "./file-viewer-services";

/** Resource authority comes from the owned target and installed services. */
export function withFileViewerHost(
  owned: WidgetHost,
  policy: WidgetHost,
  handle: ThreadAppHandle,
  services: ReturnType<typeof createFileViewerServices>,
): WidgetHost {
  if (!handle.file || !services) return owned;
  return {
    ...owned,
    services: {
      ...owned.services,
      ...services,
      configureAppBridge(bridge, capabilities) {
        const original = owned.services.configureAppBridge?.(
          bridge,
          capabilities,
        );
        const file = services.configureAppBridge(bridge, capabilities);
        return () => {
          try {
            file?.();
          } finally {
            original?.();
          }
        };
      },
    },
    resolvers: {
      ...owned.resolvers,
      resolveEffectiveHostCapabilities: (args) => {
        const native = policy.resolvers.resolveEffectiveHostCapabilities(args);
        const matrix =
          policy.resolvers.resolveEffectiveMcpAppsCapabilities(args);
        const capabilities =
          owned.resolvers.resolveEffectiveHostCapabilities(args);
        return {
          ...capabilities,
          ...(native.serverResources && matrix.serverResources
            ? {
                serverResources: native.serverResources,
                experimental: {
                  ...capabilities.experimental,
                  "openai/resource": {},
                },
              }
            : {}),
        };
      },
      resolveEffectiveMcpAppsCapabilities: (args) => ({
        ...owned.resolvers.resolveEffectiveMcpAppsCapabilities(args),
        serverResources:
          !!policy.resolvers.resolveEffectiveHostCapabilities(args)
            .serverResources &&
          policy.resolvers.resolveEffectiveMcpAppsCapabilities(args)
            .serverResources,
      }),
    },
  };
}
