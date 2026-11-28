import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@mcpjam/design-system/button";
import { FieldError } from "@mcpjam/design-system/field-error";
import { Input } from "@mcpjam/design-system/input";
import { cn } from "@mcpjam/design-system/cn";
import { ErrorCard } from "@/components/ui/error-card";
import { getConnectionStatusMeta } from "@/components/connection/server-card-utils";
import { deriveServerName } from "@/components/onboarding/FirstRunOnboardingOverlay";
import { reportCaught } from "@/lib/error-reporting";
import { EXCALIDRAW_SERVER_CONFIG } from "@/lib/excalidraw-quick-connect";
import { validateServerFormData } from "@/lib/server-form-validation";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/state/app-types";
import { StatusSwap } from "./checklist-motion";

/** How long typing has to pause before a valid URL starts connecting. */
export const CONNECT_TYPING_PAUSE_MS = 1000;

export type ConnectAction =
  | "auto_started"
  | "demo_started"
  | "confirmed"
  | "denied"
  | "failed"
  | "retried";

interface Attempt {
  name: string;
  formData: ServerFormData;
  /** Only a server this attempt created is removed on cancel or deny. */
  created: boolean;
}

function urlOf(server: ServerWithName | undefined): string | null {
  return server?.config && "url" in server.config
    ? String(server.config.url)
    : null;
}

function nameFor(url: string, servers: Record<string, ServerWithName>) {
  const base = deriveServerName(url);
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!servers[name]) return name;
  }
}

function looksLikeUrl(value: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(value)) return false;
  try {
    const { hostname } = new URL(value);
    return (
      hostname.includes(".") ||
      hostname === "localhost" ||
      hostname.startsWith("[")
    );
  } catch {
    return false;
  }
}

export function ConnectStep({
  servers,
  onConnect,
  onRemove,
  onReconnect,
  onConfirmed,
  onTrack,
  onAttemptChange,
}: {
  servers: Record<string, ServerWithName>;
  onConnect: (
    formData: ServerFormData,
    options: { suppressErrorToast: boolean; suppressSuccessToast: boolean },
  ) => Promise<unknown>;
  onRemove: (name: string) => Promise<unknown>;
  /** Reconnects a saved server as it is, keeping its saved authentication. */
  onReconnect: (name: string) => Promise<unknown>;
  onConfirmed: (name: string) => void;
  onTrack: (action: ConnectAction, extra?: { error_slug?: string }) => void;
  /**
   * Servers not to count as connected: the unconfirmed attempt, and earlier
   * attempts whose removal hasn't landed yet.
   */
  onAttemptChange: (names: string[]) => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttemptState] = useState<Attempt | null>(null);
  // Read by the unmount cleanup, which outlives the last render's state.
  const attemptRef = useRef<Attempt | null>(null);
  const removing = useRef(new Set<string>());
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ onRemove, onAttemptChange, onTrack, remove });
  latest.current = { onRemove, onAttemptChange, onTrack, remove };
  // A failed removal leaves the server in place, so it can count again.
  function remove(name: string) {
    removing.current.add(name);
    void latest.current.onRemove(name).catch((error: unknown) => {
      removing.current.delete(name);
      report();
      reportCaught(error, { source: "home_checklist_connect_remove" });
    });
  }
  const report = () => {
    const current = attemptRef.current?.name;
    const pending = [...removing.current].filter((name) => name !== current);
    latest.current.onAttemptChange(current ? [current, ...pending] : pending);
  };
  // Reported in the same update that adds the server, so Home never counts an
  // unconfirmed attempt as connected for a render.
  const setAttempt = (next: Attempt | null) => {
    if (next) removing.current.delete(next.name);
    attemptRef.current = next;
    setAttemptState(next);
    report();
  };
  useEffect(() => {
    let landed = false;
    for (const name of removing.current) {
      if (servers[name]) continue;
      removing.current.delete(name);
      landed = true;
    }
    if (landed) report();
  }, [servers]);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      const current = attemptRef.current;
      if (current?.created) latest.current.remove(current.name);
      attemptRef.current = null;
      report();
    },
    [],
  );

  const server = attempt ? servers[attempt.name] : undefined;
  const status = attempt ? (server?.connectionStatus ?? "connecting") : null;

  const errorSlug = server?.lastNormalizedError?.slug;
  const trackedFailure = useRef<Attempt | null>(null);
  useEffect(() => {
    if (status !== "failed" || !attempt) return;
    if (trackedFailure.current === attempt) return;
    trackedFailure.current = attempt;
    latest.current.onTrack(
      "failed",
      errorSlug ? { error_slug: errorSlug } : {},
    );
  }, [status, attempt, errorSlug]);

  const discard = (current: Attempt | null) => {
    if (current?.created) remove(current.name);
  };

  const connect = (target: Attempt) => {
    if (!target.created) {
      void onReconnect(target.name);
      return;
    }
    void onConnect(target.formData, {
      suppressErrorToast: true,
      suppressSuccessToast: true,
    });
  };

  const start = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!looksLikeUrl(trimmed)) {
      setError("Enter a full URL, like https://mcp.example.com/mcp.");
      return;
    }
    const saved = Object.values(servers).find(
      (candidate) => urlOf(candidate) === trimmed,
    );
    const name = saved?.name ?? nameFor(trimmed, servers);
    const formData: ServerFormData = {
      name,
      type: "http",
      url: trimmed,
      useOAuth: true,
      authMethod: "auto",
    };
    const invalid = validateServerFormData(formData);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    const next = { name, formData, created: !saved };
    setAttempt(next);
    onTrack("auto_started");
    connect(next);
  };

  const startDemo = () => {
    window.clearTimeout(timer.current);
    const { name } = EXCALIDRAW_SERVER_CONFIG;
    if (attempt?.name === name) {
      trackedFailure.current = null;
      onTrack("retried");
      connect(attempt);
      return;
    }
    discard(attempt);
    const next = {
      name,
      formData: EXCALIDRAW_SERVER_CONFIG,
      created: !servers[name],
    };
    setUrl("");
    setError(null);
    setAttempt(next);
    onTrack("demo_started");
    connect(next);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setUrl(value);
    setError(null);
    window.clearTimeout(timer.current);
    if (attempt) {
      discard(attempt);
      setAttempt(null);
    }
    const pasted =
      (event.nativeEvent as InputEvent).inputType === "insertFromPaste";
    if (pasted) start(value);
    else
      timer.current = window.setTimeout(
        () => start(value),
        CONNECT_TYPING_PAUSE_MS,
      );
  };

  const reset = () => {
    discard(attempt);
    setAttempt(null);
    setUrl("");
  };

  const meta = status ? getConnectionStatusMeta(status) : null;
  const statusKey = !attempt
    ? "idle"
    : status === "connecting" || status === "oauth-flow"
      ? "connecting"
      : status === "connected"
        ? "connected"
        : status === "failed" || status === "disconnected"
          ? "failed"
          : "other";

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Paste your MCP server&apos;s URL. MCPJam connects as soon as the URL is
        valid.
      </p>
      <div className="space-y-1.5">
        <Input
          type="url"
          inputMode="url"
          aria-label="Server URL"
          aria-invalid={error ? true : undefined}
          placeholder="https://mcp.example.com/mcp"
          value={url}
          onChange={onChange}
        />
        <FieldError>{error}</FieldError>
      </div>
      <StatusSwap swapKey={statusKey}>
        {attempt &&
        meta &&
        (status === "connecting" || status === "oauth-flow") ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <meta.Icon className={meta.iconClassName} aria-hidden />
            <span className="flex-1" role="status">
              {meta.label}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={reset}>
              Cancel
            </Button>
          </div>
        ) : null}
        {attempt && meta && status === "connected" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm" role="status">
              <span
                className={cn("size-2 rounded-full", meta.indicatorClassName)}
                aria-hidden
              />
              <span className="text-foreground">
                Connected to {attempt.name}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  onTrack("confirmed");
                  onConfirmed(attempt.name);
                  setAttempt(null);
                  setUrl("");
                }}
              >
                Confirm
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onTrack("denied");
                  reset();
                }}
              >
                Use a different server
              </Button>
            </div>
          </div>
        ) : null}
        {attempt && (status === "failed" || status === "disconnected") ? (
          <ErrorCard
            density="row"
            error={
              server?.lastNormalizedError ??
              server?.lastError ??
              `Couldn't connect to ${attempt.formData.url}. Check the URL and try again.`
            }
            onRetry={() => {
              trackedFailure.current = null;
              onTrack("retried");
              connect(attempt);
            }}
          />
        ) : null}
        {!attempt || status === "failed" || status === "disconnected" ? (
          <p className="text-sm text-muted-foreground">
            No server handy?{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={startDemo}
            >
              Use the Excalidraw demo server
            </Button>
          </p>
        ) : null}
      </StatusSwap>
    </>
  );
}
