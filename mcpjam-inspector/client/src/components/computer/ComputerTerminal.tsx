import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@mcpjam/design-system/button";
import { Copy, Eraser, Loader2, RotateCcw, TerminalSquare } from "lucide-react";
import { toast } from "sonner";
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

const DARK_THEME: ITheme = {
  background: "#1a1916",
  foreground: "#e8e4d8",
  cursor: "#d4762e",
  cursorAccent: "#1a1916",
  selectionBackground: "rgba(212, 118, 46, 0.3)",
  black: "#1a1916",
  brightBlack: "#5a5648",
  red: "#e06c75",
  brightRed: "#e06c75",
  green: "#98c379",
  brightGreen: "#98c379",
  yellow: "#e5c07b",
  brightYellow: "#e5c07b",
  blue: "#61afef",
  brightBlue: "#61afef",
  magenta: "#c678dd",
  brightMagenta: "#c678dd",
  cyan: "#56b6c2",
  brightCyan: "#56b6c2",
  white: "#abb2bf",
  brightWhite: "#e8e4d8",
};

const LIGHT_THEME: ITheme = {
  background: "#f5f0e8",
  foreground: "#2c2a24",
  cursor: "#c96a2e",
  cursorAccent: "#f5f0e8",
  selectionBackground: "rgba(201, 106, 46, 0.2)",
  black: "#2c2a24",
  brightBlack: "#767060",
  red: "#c0392b",
  brightRed: "#e74c3c",
  green: "#27ae60",
  brightGreen: "#2ecc71",
  yellow: "#b07800",
  brightYellow: "#e5a000",
  blue: "#2471a3",
  brightBlue: "#3498db",
  magenta: "#7d3c98",
  brightMagenta: "#9b59b6",
  cyan: "#148f77",
  brightCyan: "#1abc9c",
  white: "#e8e4d8",
  brightWhite: "#f5f0e8",
};

function themeFor(mode: "light" | "dark"): ITheme {
  return mode === "dark" ? DARK_THEME : LIGHT_THEME;
}

function closeMessage(code: number, reason: string): string {
  if (code === 4401) return "Session expired — reconnect to continue.";
  if (code === 4503) return "Computer is unavailable right now.";
  return reason || "Disconnected from the computer.";
}

const STATUS_CONFIG: Record<TerminalState, { dot: string; label: string }> = {
  connecting:   { dot: "bg-amber-400 animate-pulse", label: "Connecting" },
  connected:    { dot: "bg-emerald-500",              label: "Connected" },
  exited:       { dot: "bg-zinc-400",                 label: "Exited" },
  disconnected: { dot: "bg-zinc-400",                 label: "Disconnected" },
  error:        { dot: "bg-red-500",                  label: "Error" },
};

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
  const [hasSelection, setHasSelection] = useState(false);

  const termBg = themeMode === "dark" ? "#1a1916" : "#f5f0e8";
  const toolbarBg = themeMode === "dark" ? "#222019" : "#ede7d8";

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

  const handleCopy = useCallback(() => {
    const sel = termRef.current?.getSelection();
    if (sel) {
      void navigator.clipboard.writeText(sel);
      toast.success("Copied", { duration: 1500 });
    }
  }, []);

  const handleClear = useCallback(() => {
    termRef.current?.clear();
    termRef.current?.focus();
  }, []);

  // Create the xterm instance once; wire input + resize; auto-connect.
  useEffect(() => {
    disposedRef.current = false;
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      lineHeight: 1.45,
      fontFamily:
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: themeFor(themeMode),
      scrollback: 10_000,
      smoothScrollDuration: 100,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    // GPU-accelerated renderer; falls back to canvas automatically.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // canvas fallback is automatic
    }

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
    const selSub = term.onSelectionChange(() => {
      setHasSelection(term.hasSelection());
    });

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
      selSub.dispose();
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
      <div
        className="flex h-full flex-col overflow-hidden rounded-lg border shadow-sm"
        style={{ background: termBg }}
      >
        {/* Toolbar */}
        <div
          className="flex shrink-0 items-center justify-between border-b px-3"
          style={{ height: 36, background: toolbarBg }}
        >
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-3.5 w-3.5 text-muted-foreground/50" />
            <span className="font-mono text-xs text-muted-foreground/60">
              bash
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span
              className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${STATUS_CONFIG[state].dot}`}
              title={STATUS_CONFIG[state].label}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground/60 hover:text-muted-foreground"
              disabled={!hasSelection}
              onClick={handleCopy}
              title="Copy selection"
            >
              <Copy className="h-3 w-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground/60 hover:text-muted-foreground"
              onClick={handleClear}
              title="Clear terminal"
            >
              <Eraser className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Terminal canvas + overlay */}
        <div className="relative min-h-0 flex-1">
          <div ref={containerRef} className="absolute inset-0 p-1" onClick={() => termRef.current?.focus()} />
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
    </div>
  );
}
