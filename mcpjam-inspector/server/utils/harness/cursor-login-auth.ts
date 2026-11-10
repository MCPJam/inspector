import type { HarnessV1, HarnessV1StartOptions } from "@ai-sdk/harness";
import { isRecord } from "@ai-sdk/provider-utils";

const CONFIG_ENV = "AI_SDK_ACP_BRIDGE_CONFIGURATION";

/** Cursor's file login requires ACP authenticate before session/new or session/load. */
export function withCursorLoginAuthentication<T extends HarnessV1>(
  harness: T,
): T {
  return {
    ...harness,
    doStart(options) {
      const sandboxSession = wrapSandbox(options.sandboxSession);
      return harness.doStart({ ...options, sandboxSession });
    },
  };
}

function wrapSandbox(
  sandbox: HarnessV1StartOptions["sandboxSession"],
): HarnessV1StartOptions["sandboxSession"] {
  return new Proxy(sandbox, {
    get(target, property) {
      if (property === "restricted" && "restricted" in target)
        return () => wrapSandbox(target.restricted());
      if (property === "spawn") {
        return (args: Parameters<typeof target.spawn>[0]) => {
          const serialized = args.env?.[CONFIG_ENV];
          if (serialized === undefined) return target.spawn(args);
          const configuration: unknown = JSON.parse(serialized);
          if (!isRecord(configuration))
            throw new Error("Cursor authentication configuration is invalid.");
          return target.spawn({
            ...args,
            env: {
              ...args.env,
              [CONFIG_ENV]: JSON.stringify({
                ...configuration,
                authentication: { methodId: "cursor_login" },
              }),
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
