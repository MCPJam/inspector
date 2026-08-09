import { useCallback, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { HOSTED_MODE } from "@/lib/config";
import {
  parseFirstRunServerInput,
  type ParsedFirstRunServerInput,
} from "@/lib/first-run-server-input";
import {
  EXCALIDRAW_SERVER_CONFIG,
  EXCALIDRAW_SERVER_NAME,
} from "@/lib/excalidraw-quick-connect";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import type { EnsureServerConnectionResult } from "@/hooks/use-server-state";
import type { ServerFormData } from "@/shared/types.js";

export type FirstRunSource = "own" | "demo";

export type FirstRunPhase =
  | { kind: "choosing" }
  | { kind: "connecting"; serverName: string; source: FirstRunSource }
  | {
      kind: "error";
      /**
       * `reauth` is a distinct outcome, not a flavour of failure: the server
       * answered correctly and is telling us it needs authorization, so the
       * recovery is "Authorize", not "Retry".
       */
      reason: "reauth" | "failed";
      message: string;
      serverName: string;
      source: FirstRunSource;
    };

export interface UseFirstRunConnectOptions {
  saveServer: (formData: ServerFormData) => Promise<boolean>;
  connectServer: (serverName: string) => Promise<EnsureServerConnectionResult>;
  onConnected: (serverName: string, source: FirstRunSource) => void;
  onAuthorize: (serverName: string) => void;
  hostedMode?: boolean;
}

export interface UseFirstRunConnectReturn {
  phase: FirstRunPhase;
  /** Validation feedback for the input itself, shown before any connect starts. */
  inputError: string | null;
  connectOwnServer: (rawInput: string) => void;
  connectDemoServer: () => void;
  retry: () => void;
  authorize: () => void;
  backToChoosing: () => void;
  clearInputError: () => void;
}

const GENERIC_FAILURE =
  "MCPJam couldn't complete the handshake with that server.";

export function useFirstRunConnect({
  saveServer,
  connectServer,
  onConnected,
  onAuthorize,
  hostedMode = HOSTED_MODE,
}: UseFirstRunConnectOptions): UseFirstRunConnectReturn {
  const [phase, setPhase] = useState<FirstRunPhase>({ kind: "choosing" });
  const [inputError, setInputError] = useState<string | null>(null);

  // Retry has to replay the exact config that failed, and the phase only
  // carries what the UI renders. Keeping the form data out of state also stops
  // a retry from being invalidated by an unrelated re-render.
  const lastAttemptRef = useRef<{
    formData: ServerFormData;
    source: FirstRunSource;
  } | null>(null);

  // Guards against a double-submit (Enter plus a click) starting two connects
  // for the same server, which would make one of them report `superseded`.
  const inFlightRef = useRef(false);

  const trackingProps = {
    location: "first_run",
    platform: detectPlatform(),
    environment: detectEnvironment(),
  };

  const runConnect = useCallback(
    async (formData: ServerFormData, source: FirstRunSource) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      lastAttemptRef.current = { formData, source };
      setInputError(null);
      setPhase({ kind: "connecting", serverName: formData.name, source });

      track("first_run_connect_started", { ...trackingProps, source });

      const fail = (reason: "reauth" | "failed", message: string) => {
        setPhase({
          kind: "error",
          reason,
          message,
          serverName: formData.name,
          source,
        });
        track("first_run_connect_failed", {
          ...trackingProps,
          source,
          reason,
        });
      };

      try {
        const saved = await saveServer(formData);
        if (!saved) {
          fail(
            "failed",
            "MCPJam couldn't save that server. Check the URL or command and try again."
          );
          return;
        }

        const result = await connectServer(formData.name);

        switch (result.status) {
          case "connected":
            track("first_run_connect_succeeded", { ...trackingProps, source });
            onConnected(formData.name, source);
            return;
          case "reauth":
            fail(
              "reauth",
              result.error ??
                "This server requires authorization before MCPJam can use it."
            );
            return;
          case "missing":
            fail(
              "failed",
              "MCPJam saved that server but couldn't find it to connect. Try again."
            );
            return;
          // A newer connect owns the outcome — treat it as still in progress
          // rather than reporting a failure the user didn't cause.
          case "superseded":
            return;
          case "failed":
          default:
            fail("failed", result.error ?? GENERIC_FAILURE);
            return;
        }
      } catch (error) {
        fail(
          "failed",
          error instanceof Error && error.message ? error.message : GENERIC_FAILURE
        );
      } finally {
        inFlightRef.current = false;
      }
    },
    [connectServer, onConnected, saveServer]
  );

  const connectOwnServer = useCallback(
    (rawInput: string) => {
      const parsed: ParsedFirstRunServerInput = parseFirstRunServerInput(
        rawInput,
        { hostedMode }
      );

      if (!parsed.ok) {
        setInputError(parsed.error);
        track("first_run_input_rejected", trackingProps);
        return;
      }

      void runConnect(parsed.formData, "own");
    },
    [hostedMode, runConnect]
  );

  const connectDemoServer = useCallback(() => {
    void runConnect(EXCALIDRAW_SERVER_CONFIG, "demo");
  }, [runConnect]);

  const retry = useCallback(() => {
    const attempt = lastAttemptRef.current;
    if (!attempt) {
      setPhase({ kind: "choosing" });
      return;
    }
    void runConnect(attempt.formData, attempt.source);
  }, [runConnect]);

  const authorize = useCallback(() => {
    const serverName =
      phase.kind === "error" ? phase.serverName : EXCALIDRAW_SERVER_NAME;
    track("first_run_authorize_clicked", trackingProps);
    onAuthorize(serverName);
  }, [onAuthorize, phase]);

  const backToChoosing = useCallback(() => {
    setPhase({ kind: "choosing" });
    setInputError(null);
  }, []);

  const clearInputError = useCallback(() => setInputError(null), []);

  return {
    phase,
    inputError,
    connectOwnServer,
    connectDemoServer,
    retry,
    authorize,
    backToChoosing,
    clearInputError,
  };
}
