import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@mcpjam/design-system/button";
import { Loader2, RotateCcw } from "lucide-react";
import {
  openTerminalConnection,
  type TerminalConnection,
} from "@/lib/computer-terminal-connection";

type TerminalState =
  | "connecting"
  | "connected"
  | "exited"
  | "disconnected"
  | "error";

const PING_INTERVAL_MS = 30_000;

function themeFor(mode: "light" | "dark"): ITheme {
  return mode === "dark"
    ? { background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#d4d4d4" }
    : { background: "#ffffff", foreground: "#1e1e1e", cursor: "#1e1e1e" };
}

function closeMessage(code: number, reason: string): string {
  if (code === 4401) return "Session expired — reconnect to continue.";
  if (code === 4503) return "Computer is unavailable right now.";
  return reason || "Disconnected from the computer.";
}

/**
 * Live terminal to the project's personal computer. Bridges xterm.js to the
 * inspector server's WebSocket terminal (see computer-terminal-connection).
 * `mintToken` reserves/wakes the computer and returns a fresh ~60s terminal
 * token; it's called on every (re)connect.
 */
export function ComputerTerminal({
  mintToken,
  themeMode,
  className,
  baseUrl,
}: {
  mintToken: () => Promise<string>;
  themeMode: "light" | "dark";
  className?: string;
  /**
   * `ws(s)://host` of the data plane serving the terminal. Defaults to the
   * page origin; set when this inspector delegates to a remote data plane
   * (see useComputersDataPlaneConfig).
   */
  baseUrl?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connRef = useRef<TerminalConnection | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards against a token mint resolving after the user navigated away.
  const disposedRef = useRef(false);
  // Bumped on every (re)connect so callbacks from a superseded WebSocket —
  // a late token mint, a buffered onOutput/onEvent, the old socket's onClose,
  // or a stale ping tick — can detect they belong to a dead generation and
  // bail before touching xterm or React state.
  const connGenRef = useRef(0);

  const [state, setState] = useState<TerminalState>("connecting");
  const [detail, setDetail] = useState<string>("");

  const teardownConnection = useCallback(() => {
    if (pingRef.current) {
      clearInterval(pingRef.current);
      pingRef.current = null;
    }
    connRef.current?.close();
    connRef.current = null;
  }, []);

  const connect = useCallback(async () => {
    if (disposedRef.current) return;
    // Claim this generation before tearing down the previous socket: the old
    // connection's close() fires its onClose synchronously, and the bump makes
    // that callback recognize itself as stale instead of flipping us to
    // "disconnected" right as we start reconnecting.
    const myGen = ++connGenRef.current;
    const isStale = () => disposedRef.current || myGen !== connGenRef.current;
    teardownConnection();
    setState("connecting");
    setDetail("");
    const term = termRef.current;
    if (!term) return;

    let token: string;
    try {
      token = await mintToken();
    } catch (err) {
      if (isStale()) return;
      setState("error");
      setDetail(
        err instanceof Error ? err.message : "Could not start the terminal."
      );
      return;
    }
    if (isStale()) return;

    fitRef.current?.fit();
    const conn = openTerminalConnection({
      token,
      cols: term.cols,
      rows: term.rows,
      ...(baseUrl ? { baseUrl } : {}),
      onOutput: (bytes) => {
        if (isStale()) return;
        term.write(bytes);
      },
      onEvent: (event) => {
        if (isStale()) return;
        if (event.type === "ready") {
          setState("connected");
          term.focus();
        } else if (event.type === "exit") {
          setState("exited");
          setDetail("The shell session ended.");
        } else if (event.type === "error") {
          setState("error");
          setDetail(event.message);
        }
      },
      onClose: (code, reason) => {
        if (isStale()) return;
        setState((prev) =>
          prev === "exited" || prev === "error" ? prev : "disconnected"
        );
        setDetail((prev) => prev || closeMessage(code, reason));
      },
    });
    connRef.current = conn;
    pingRef.current = setInterval(() => {
      if (isStale()) return;
      conn.ping();
    }, PING_INTERVAL_MS);
  }, [mintToken, teardownConnection, baseUrl]);

  // Create the xterm instance once; wire input + resize; auto-connect.
  useEffect(() => {
    disposedRef.current = false;
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: themeFor(themeMode),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const encoder = new TextEncoder();
    const dataSub = term.onData((data) =>
      connRef.current?.sendInput(encoder.encode(data))
    );
    const resizeSub = term.onResize(({ cols, rows }) =>
      connRef.current?.resize(cols, rows)
    );

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // container detached mid-resize; ignore.
      }
    });
    observer.observe(container);

    void connect();

    return () => {
      disposedRef.current = true;
      teardownConnection();
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // connect/teardown are stable (useCallback); themeMode handled separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-theme without recreating the terminal.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFor(themeMode);
  }, [themeMode]);

  const showOverlay = state !== "connected";

  return (
    <div className={className}>
      <div className="relative h-full w-full overflow-hidden rounded-md border bg-[#1e1e1e]">
        <div ref={containerRef} className="h-full w-full p-2" />
        {showOverlay ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 text-sm">
            {state === "connecting" ? (
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Connecting to your computer…
              </span>
            ) : (
              <>
                <span className="text-muted-foreground">
                  {detail ||
                    (state === "exited"
                      ? "The shell session ended."
                      : "Disconnected from the computer.")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void connect()}
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Reconnect
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
