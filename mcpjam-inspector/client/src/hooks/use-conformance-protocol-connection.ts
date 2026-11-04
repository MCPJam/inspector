import { useEffect, useMemo, useState } from "react";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { ProtocolVersionPin } from "./conformance-suite-state";
import type { ConformanceConnectionResult } from "@/shared/conformance-connection";
import { checkConformanceConnection } from "@/lib/apis/conformance-connection-api";

export function useConformanceProtocolConnection(
  server: ServerWithName | undefined,
  version: ProtocolVersionPin,
) {
  const [attempt, setAttempt] = useState(0);
  const name = server?.name;
  const config = server?.config;
  const tokens = server?.oauthTokens;
  const connectedAt = server?.lastConnectionTime;
  const connected = server?.connectionStatus === "connected";
  const required = version !== "auto" && !!config && "url" in config;
  const request = useMemo(
    () => ({ name, version, config, tokens, connectedAt, connected, attempt }),
    [name, version, config, tokens, connectedAt, connected, attempt],
  );
  const [checked, setChecked] = useState<{
    request: typeof request;
    result: ConformanceConnectionResult;
  }>();

  useEffect(() => {
    if (
      !required ||
      !request.connected ||
      !request.name ||
      request.version === "auto"
    )
      return;
    let cancelled = false;
    const finish = (result: ConformanceConnectionResult) => {
      if (!cancelled) setChecked({ request, result });
    };
    checkConformanceConnection(request.name, request.version).then(
      finish,
      (error: unknown) =>
        finish({
          status: "failed",
          message:
            error instanceof Error
              ? error.message
              : "Could not check the connection. Try again.",
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [required, request]);

  const result =
    required && checked?.request === request ? checked.result : undefined;
  return {
    ready: connected && (!required || result?.status === "ready"),
    checking: required && connected && !result,
    result,
    retry: () => setAttempt((value) => value + 1),
  };
}
