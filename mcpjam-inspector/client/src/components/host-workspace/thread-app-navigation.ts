import type { WidgetHost } from "@mcpjam/widget-react";
import type { ThreadAppHandle } from "./thread-app-api";

/** A host-issued namespace and current navigation port are both required. */
export function withThreadAppNavigation(
  owned: WidgetHost,
  original: WidgetHost,
  handle: ThreadAppHandle,
  open: (url: string) => Promise<void>,
): WidgetHost {
  if (!handle.deepLinkNamespace) return owned;
  return {
    ...owned,
    environment: {
      ...owned.environment,
      draftHostContext: {
        ...owned.environment.draftHostContext,
        ...(handle.deepLink ? { "openai/deepLink": handle.deepLink } : {}),
      },
    },
    services: { ...owned.services, openAppLink: open },
    resolvers: {
      ...owned.resolvers,
      resolveEffectiveHostCapabilities: (args) => {
        const native =
          original.resolvers.resolveEffectiveHostCapabilities(args);
        const matrix =
          original.resolvers.resolveEffectiveMcpAppsCapabilities(args);
        return {
          ...owned.resolvers.resolveEffectiveHostCapabilities(args),
          ...(native.openLinks && matrix.openLinks
            ? { openLinks: native.openLinks }
            : {}),
        };
      },
      resolveEffectiveMcpAppsCapabilities: (args) => ({
        ...owned.resolvers.resolveEffectiveMcpAppsCapabilities(args),
        openLinks:
          !!original.resolvers.resolveEffectiveHostCapabilities(args)
            .openLinks &&
          original.resolvers.resolveEffectiveMcpAppsCapabilities(args)
            .openLinks,
      }),
    },
  };
}
