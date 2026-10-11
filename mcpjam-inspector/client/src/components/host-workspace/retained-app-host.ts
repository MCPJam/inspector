import type {
  WidgetHost,
  WidgetHostEnvironmentInputs,
} from "@mcpjam/widget-react";
import {
  PLUGIN_EXTENSION_CAPABILITY_LABELS,
  type PluginExtensionCapabilityKey,
} from "@/lib/client-config-v2-plugin-extensions";
import type { ExtensionCapabilities } from "./extension-owners";
import { logExtensionEvent } from "./extension-log";

/**
 * A retained App's host is negotiated once, when the App opens.
 *
 * What its bridge carries (the capabilities advertised in `ui/initialize`,
 * the services and bridge extensions installed on it, the host identity,
 * style, profile and sandbox it runs under) stays fixed for the App's
 * lifetime: replacing any of it rebuilds the bridge under a guest that has
 * already initialized. A client save that changes only per-request settings
 * (extension toggles, approval, the config's content address) therefore
 * never reaches the bridge. A change to what the App is bound to is the
 * server's call (`INSTANCE_HOST_CHANGED`): the owner reopens the App.
 *
 * What may legitimately change while it stays open is host context, which
 * the renderer delivers as `ui/notifications/host-context-changed`: theme,
 * locale, time zone, device capabilities, safe area and the host's draft
 * context.
 */
const NEGOTIATED_ENVIRONMENT = [
  "sharedHostStyle",
  "scenarioHostStyle",
  "hostCapabilitiesOverride",
  "profileKey",
  "profileSandbox",
  "profileHostInfo",
  "isPlaygroundActive",
] as const satisfies readonly (keyof WidgetHostEnvironmentInputs)[];

/**
 * Fix the profile-bound resolvers to their first answer. The adapter's
 * resolvers read the live client profile; an App keeps the contract it was
 * opened with.
 */
export function negotiateRetainedAppHost(host: WidgetHost): WidgetHost {
  const stringify = host.resolvers.stableStringifyJson ?? JSON.stringify;
  const fixed = <A extends unknown[], R>(resolve: (...args: A) => R) => {
    const answers = new Map<string, R>();
    return (...args: A): R => {
      const key = stringify(args);
      if (!answers.has(key)) answers.set(key, resolve(...args));
      return answers.get(key)!;
    };
  };
  const { resolvers } = host;
  return {
    ...host,
    resolvers: {
      ...resolvers,
      resolveEffectiveCompatRuntime: fixed(
        resolvers.resolveEffectiveCompatRuntime,
      ),
      resolveEffectiveMcpAppsCapabilities: fixed(
        resolvers.resolveEffectiveMcpAppsCapabilities,
      ),
      resolveEffectiveHostCapabilities: fixed(
        resolvers.resolveEffectiveHostCapabilities,
      ),
      resolveHostInfo: fixed(resolvers.resolveHostInfo),
    },
  };
}

/**
 * The negotiated host with the current host context. `current` is the same
 * App composed over the latest ambient host; only its environment is read,
 * and the fields the bridge was negotiated on keep their opening values.
 */
export function withCurrentHostContext(
  negotiated: WidgetHost,
  current: WidgetHost,
): WidgetHost {
  const environment = { ...current.environment };
  for (const key of NEGOTIATED_ENVIRONMENT)
    (environment as Record<string, unknown>)[key] = negotiated.environment[key];
  return { ...negotiated, environment };
}

const LABELS = new Map(
  PLUGIN_EXTENSION_CAPABILITY_LABELS.map((entry) => [entry.key, entry.label]),
);

/**
 * Refuses an App request whose extension the client switched off after the
 * App opened. The server enforces the same toggle on every request; this
 * says why in the Logs and answers the App without a round trip.
 */
export function capabilityRefusal(app: {
  title: string;
  serverId: string;
  serverName: string;
  capabilities: () => ExtensionCapabilities;
}): (key: PluginExtensionCapabilityKey) => void {
  return (key) => {
    if (app.capabilities()[key]) return;
    const message = `${app.title}'s request was refused: the "${LABELS.get(key) ?? key}" extension is turned off for this client. Turn it on in the client's Apps settings (OpenAI plugin extensions).`;
    logExtensionEvent({
      serverId: app.serverId,
      serverName: app.serverName,
      label: "capability",
      level: "warning",
      message,
    });
    throw new Error(message);
  };
}

/** Messages, model context and deep links, checked on every request. */
export function guardRetainedAppRequests(
  host: WidgetHost,
  refuse: (key: PluginExtensionCapabilityKey) => void,
): WidgetHost {
  const { sendMessage, updateModelContext, openAppLink } = host.services;
  return {
    ...host,
    services: {
      ...host.services,
      ...(sendMessage
        ? {
            sendMessage: async (params: unknown) => {
              refuse("messages");
              return sendMessage(params);
            },
          }
        : {}),
      ...(updateModelContext
        ? {
            updateModelContext: async (params: unknown) => {
              refuse("modelContext");
              return updateModelContext(params);
            },
          }
        : {}),
      ...(openAppLink
        ? {
            openAppLink: async (url: string) => {
              refuse("deepLinks");
              return openAppLink(url);
            },
          }
        : {}),
    },
  };
}
