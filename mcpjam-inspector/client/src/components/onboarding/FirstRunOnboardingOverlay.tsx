import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useReducedMotion } from "framer-motion";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Check, Circle, Loader2 } from "lucide-react";

/** Time the welcome splash remains visible before it advances to server choice. */
export const FIRST_RUN_WELCOME_AUTO_ADVANCE_MS = 8_500;

type FirstRunOverlayStep =
  | "welcome"
  | "choose"
  | "connecting"
  | "connected"
  | "demo-failed"
  | "server-details";

export type FirstRunServerKind = "demo" | "personal";

export type FirstRunConnectionState =
  | { status: "idle" }
  | {
      status: "preparing" | "connecting" | "loading-tools";
      serverName: string;
      serverKind: FirstRunServerKind;
    }
  | {
      status: "connected";
      serverName: string;
      serverKind: FirstRunServerKind;
      toolCount: number;
    }
  | {
      status: "failed";
      serverName: string;
      serverKind: FirstRunServerKind;
      error: string;
    };

export interface FirstRunServerDraft {
  name: string;
  transport: "http" | "stdio";
  urlOrCommand: string;
  authentication: "auto" | "oauth" | "bearer" | "none";
  header: string;
}

interface FirstRunOnboardingOverlayProps {
  open: boolean;
  skipWelcome?: boolean;
  connectionState: FirstRunConnectionState;
  onConnectOwnServer: (draft: FirstRunServerDraft) => void;
  onConnectDemo: () => void;
  onCancelConnection: () => void;
  onOpenPlayground: () => void;
  onWelcomeShown: () => void;
  onWelcomeAcknowledged: () => void;
  onSkip: () => void;
}

/**
 * The Home-mounted shell for first-run onboarding.
 *
 * It owns the welcome, initial URL capture, and editable failure recovery.
 * The parent sends each draft through the existing save-and-connect path, then
 * reports the real connection outcome back here for the next visible state.
 */
export function FirstRunOnboardingOverlay({
  open,
  skipWelcome = false,
  connectionState,
  onConnectOwnServer,
  onConnectDemo,
  onCancelConnection,
  onOpenPlayground,
  onWelcomeShown,
  onWelcomeAcknowledged,
  onSkip,
}: FirstRunOnboardingOverlayProps) {
  const prefersReducedMotion = useReducedMotion();
  const [step, setStep] = useState<FirstRunOverlayStep>(() =>
    skipWelcome ? "choose" : "welcome",
  );
  const [isWelcomeCountdownRunning, setIsWelcomeCountdownRunning] =
    useState(false);
  const [serverUrlOrCommand, setServerUrlOrCommand] = useState("");
  const [serverUrlError, setServerUrlError] = useState<string | null>(null);
  const [serverName, setServerName] = useState("");
  const [serverTransport, setServerTransport] = useState<"http" | "stdio">(
    "http",
  );
  const [serverAuthentication, setServerAuthentication] =
    useState<FirstRunServerDraft["authentication"]>("auto");
  const [serverHeader, setServerHeader] = useState("");

  useEffect(() => {
    if (!open) setStep(skipWelcome ? "choose" : "welcome");
  }, [open, skipWelcome]);

  useEffect(() => {
    if (open && step === "welcome") onWelcomeShown();
  }, [onWelcomeShown, open, step]);

  const continueToChoice = useCallback(() => {
    onWelcomeAcknowledged();
    setStep("choose");
  }, [onWelcomeAcknowledged]);

  const connectWithInitialDefaults = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedUrlOrCommand = serverUrlOrCommand.trim();
      if (!trimmedUrlOrCommand) {
        setServerUrlError("Enter a server URL or command.");
        return;
      }

      setServerUrlError(null);
      setServerUrlOrCommand(trimmedUrlOrCommand);
      const inferredName = serverName || deriveServerName(trimmedUrlOrCommand);
      const inferredTransport = /^https?:\/\//i.test(trimmedUrlOrCommand)
        ? "http"
        : "stdio";
      setServerName(inferredName);
      setServerTransport(inferredTransport);
      onConnectOwnServer({
        name: inferredName,
        transport: inferredTransport,
        urlOrCommand: trimmedUrlOrCommand,
        authentication: "auto",
        header: "",
      });
    },
    [onConnectOwnServer, serverName, serverUrlOrCommand],
  );

  const submitServerDetails = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      onConnectOwnServer({
        name: serverName.trim() || deriveServerName(serverUrlOrCommand),
        transport: serverTransport,
        urlOrCommand: serverUrlOrCommand,
        authentication: serverAuthentication,
        header: serverHeader.trim(),
      });
    },
    [
      onConnectOwnServer,
      serverAuthentication,
      serverHeader,
      serverName,
      serverTransport,
      serverUrlOrCommand,
    ],
  );

  useEffect(() => {
    if (!open) return;
    if (
      connectionState.status === "preparing" ||
      connectionState.status === "connecting" ||
      connectionState.status === "loading-tools"
    ) {
      setStep("connecting");
    } else if (connectionState.status === "connected") {
      setStep("connected");
    } else if (connectionState.status === "failed") {
      setStep(
        connectionState.serverKind === "demo"
          ? "demo-failed"
          : "server-details",
      );
    }
  }, [connectionState, open]);

  useEffect(() => {
    if (!open || step !== "welcome" || prefersReducedMotion) return;
    const timeoutId = window.setTimeout(
      continueToChoice,
      FIRST_RUN_WELCOME_AUTO_ADVANCE_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [continueToChoice, open, prefersReducedMotion, step]);

  // Start the CSS transition in a later browser task so the countdown paints at
  // full width before it begins shrinking. The same duration drives the visual
  // cue and the auto-advance timeout above.
  useEffect(() => {
    setIsWelcomeCountdownRunning(false);
    if (!open || step !== "welcome" || prefersReducedMotion) return;

    const startId = window.setTimeout(() => {
      setIsWelcomeCountdownRunning(true);
    }, 0);
    return () => window.clearTimeout(startId);
  }, [open, prefersReducedMotion, step]);

  useEffect(() => {
    if (!open || step !== "welcome") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      continueToChoice();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [continueToChoice, open, step]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onSkip()}>
      <DialogPortal>
        <DialogOverlay
          className={
            step === "welcome"
              ? "backdrop-blur-[32px] backdrop-brightness-50"
              : "backdrop-blur-sm"
          }
        />
        <DialogPrimitive.Content
          className={cn(
            "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg",
            step === "welcome"
              ? "max-w-[420px] gap-0 border-0 bg-transparent p-1 text-left shadow-none"
              : "max-h-[calc(100vh-2rem)] max-w-[408px] gap-0 overflow-y-auto rounded-xl border-border bg-card p-6 shadow-none",
          )}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => {
            event.preventDefault();
            if (step === "welcome") continueToChoice();
          }}
        >
          {step === "welcome" ? (
            <>
              <DialogHeader className="gap-0 text-left">
                <DialogTitle className="max-w-[12ch] pb-0 text-[2rem] leading-[1.12] font-semibold tracking-[-0.038em] text-primary-foreground">
                  Welcome to MCPJam
                </DialogTitle>
                <span
                  className="mt-4 block h-px w-[72px] bg-primary"
                  aria-hidden
                />
                <DialogDescription className="mt-4 max-w-[42ch] text-[14.5px] leading-[1.5] text-primary-foreground/80">
                  From your first prompt to a continuous gate on every release,
                  MCPJam shows what breaks across every AI client, and how to
                  fix it.
                </DialogDescription>
              </DialogHeader>
              <Button
                type="button"
                variant="link"
                className="mt-7 h-auto justify-self-start p-0 text-[12.5px] font-semibold text-primary-foreground underline decoration-primary-foreground/35 underline-offset-4 hover:text-primary-foreground hover:decoration-primary-foreground focus-visible:!border-0 focus-visible:!ring-0"
                onClick={continueToChoice}
              >
                Continue
              </Button>
              {!prefersReducedMotion ? (
                <div
                  className="mt-6 h-px w-full overflow-hidden bg-primary-foreground/25"
                  data-testid="welcome-countdown"
                  aria-hidden
                >
                  <div
                    className="h-full w-full origin-left bg-primary transition-transform ease-linear motion-reduce:hidden"
                    data-testid="welcome-countdown-bar"
                    style={{
                      transform: isWelcomeCountdownRunning
                        ? "scaleX(0)"
                        : "scaleX(1)",
                      transitionDuration: `${FIRST_RUN_WELCOME_AUTO_ADVANCE_MS}ms`,
                    }}
                  />
                </div>
              ) : null}
            </>
          ) : step === "choose" ? (
            <>
              <DialogHeader className="gap-0 text-left">
                <DialogTitle className="pb-0 text-[17px] leading-6 font-bold tracking-[-0.02em] text-card-foreground">
                  Point MCPJam at a server
                </DialogTitle>
                <DialogDescription className="mt-1 text-[12.5px] leading-[1.55] text-muted-foreground">
                  MCPJam connects to your MCP server and lets you call its
                  tools, inspect traces, and see how different clients handle
                  it.
                </DialogDescription>
              </DialogHeader>

              <form className="mt-[18px]" onSubmit={connectWithInitialDefaults}>
                <Label
                  htmlFor="first-run-server-url"
                  className="font-mono text-[9.5px] tracking-[0.1em] text-muted-foreground uppercase"
                >
                  Server URL or command
                </Label>
                <Input
                  id="first-run-server-url"
                  className="mt-1.5 h-10 border-border bg-card font-mono text-[11.5px] shadow-none"
                  placeholder="https://mcp.example.com/mcp"
                  spellCheck={false}
                  autoComplete="off"
                  value={serverUrlOrCommand}
                  aria-invalid={serverUrlError ? true : undefined}
                  onChange={(event) => {
                    setServerUrlOrCommand(event.target.value);
                    if (serverUrlError) setServerUrlError(null);
                  }}
                />
                {serverUrlError ? (
                  <p
                    className="mt-1.5 text-[10.5px] text-destructive"
                    role="alert"
                  >
                    {serverUrlError}
                  </p>
                ) : (
                  <p className="mt-1.5 text-[10.5px] text-muted-foreground">
                    HTTP, SSE, and stdio all work.
                  </p>
                )}
                <Button
                  type="submit"
                  className="mt-3 h-auto w-full rounded-md px-4 py-2.5 text-[12.5px] font-semibold shadow-none"
                >
                  Connect
                </Button>
              </form>

              <div className="grid gap-0">
                <div
                  className="flex items-center gap-3 py-4 text-[9.5px] tracking-[0.1em] text-muted-foreground uppercase before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
                  role="separator"
                >
                  or
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full bg-card px-4 py-2.5 text-[12.5px] font-semibold shadow-none hover:border-primary hover:bg-card hover:text-foreground"
                  onClick={() => onConnectDemo()}
                >
                  Try the Excalidraw demo server
                </Button>
                <p className="mt-1.5 text-center text-[10.5px] text-muted-foreground">
                  6 tools · no setup · nothing to install
                </p>
              </div>
              <Button
                type="button"
                variant="link"
                className="mx-auto mt-3 h-auto p-1 text-[11px] font-normal text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-primary"
                onClick={onSkip}
              >
                Set up later
              </Button>
            </>
          ) : step === "connecting" &&
            (connectionState.status === "preparing" ||
              connectionState.status === "connecting" ||
              connectionState.status === "loading-tools") ? (
            <div className="py-1">
              <DialogHeader className="gap-0 text-left">
                <DialogTitle className="text-[17px] leading-6 font-bold tracking-[-0.02em] text-card-foreground">
                  {connectionState.status === "preparing"
                    ? "Preparing your MCPJam workspace"
                    : "Connecting to "}
                  {connectionState.status !== "preparing"
                    ? connectionState.serverName
                    : null}
                </DialogTitle>
                <DialogDescription className="mt-1 text-[12.5px] leading-[1.55] text-muted-foreground">
                  {connectionState.status === "preparing"
                    ? "Getting your project ready to connect to an MCP server."
                    : "Checking the connection before MCPJam opens the playground."}
                </DialogDescription>
              </DialogHeader>
              <ConnectionProgress
                status={connectionState.status}
                prefersReducedMotion={prefersReducedMotion}
              />
              <Button
                type="button"
                variant="link"
                className="mx-auto mt-4 h-auto p-1 text-[11px] font-normal text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-primary"
                onClick={() => {
                  onCancelConnection();
                  setStep("choose");
                }}
              >
                Cancel
              </Button>
            </div>
          ) : step === "connected" && connectionState.status === "connected" ? (
            <div className="py-2 text-center">
              <div
                className={cn(
                  "mx-auto flex size-12 items-center justify-center rounded-full border border-success bg-success text-success-foreground",
                  !prefersReducedMotion &&
                    "animate-in fade-in zoom-in-50 duration-500",
                )}
                data-testid="first-run-success-indicator"
                aria-hidden
              >
                <span
                  className={cn(
                    "flex",
                    !prefersReducedMotion &&
                      "animate-in fade-in zoom-in-50 delay-150 duration-300",
                  )}
                >
                  <Check className="size-6" strokeWidth={2.25} />
                </span>
              </div>
              <DialogHeader className="mt-5 gap-0 !text-center">
                <DialogTitle className="text-center text-[17px] leading-6 font-bold tracking-[-0.02em] text-card-foreground">
                  Connected to{" "}
                  <span className="text-success">
                    {connectionState.serverName}
                  </span>
                </DialogTitle>
                <DialogDescription className="mt-1 text-center text-[12.5px] leading-[1.55] text-muted-foreground">
                  {connectionState.toolCount}{" "}
                  {connectionState.toolCount === 1 ? "tool" : "tools"} ready to
                  use.
                </DialogDescription>
              </DialogHeader>
              <Button
                type="button"
                className="mt-5 h-auto w-full rounded-md px-4 py-2.5 text-[12.5px] font-semibold shadow-none"
                onClick={onOpenPlayground}
              >
                Open Playground
              </Button>
            </div>
          ) : step === "demo-failed" && connectionState.status === "failed" ? (
            <div>
              <DialogHeader className="gap-0 text-left">
                <DialogTitle className="pb-0 text-[17px] leading-6 font-bold tracking-[-0.02em] text-card-foreground">
                  Demo server unavailable
                </DialogTitle>
                <DialogDescription className="mt-1 text-[12.5px] leading-[1.55] text-muted-foreground">
                  MCPJam couldn&apos;t reach the Excalidraw demo server. You can
                  try again or connect your own server instead.
                </DialogDescription>
              </DialogHeader>
              <p
                className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] leading-[1.45] text-destructive"
                role="alert"
              >
                {connectionState.error}
              </p>
              <Button
                type="button"
                className="mt-4 h-auto w-full rounded-md px-4 py-2.5 text-[12.5px] font-semibold shadow-none"
                onClick={onConnectDemo}
              >
                Try demo again
              </Button>
              <Button
                type="button"
                variant="link"
                className="mx-auto mt-3 h-auto p-1 text-[11px] font-normal text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-primary"
                onClick={() => setStep("choose")}
              >
                Connect my own server
              </Button>
            </div>
          ) : (
            <form onSubmit={submitServerDetails}>
              <DialogHeader className="gap-0 text-left">
                <DialogTitle className="pb-0 text-[17px] leading-6 font-bold tracking-[-0.02em] text-card-foreground">
                  Set up your server
                </DialogTitle>
                <DialogDescription className="mt-1 text-[12.5px] leading-[1.55] text-muted-foreground">
                  MCPJam couldn&apos;t connect with the default settings. Update
                  the details and try again.
                </DialogDescription>
              </DialogHeader>

              {connectionState.status === "failed" ? (
                <p
                  className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] leading-[1.45] text-destructive"
                  role="alert"
                >
                  {connectionState.error}
                </p>
              ) : null}

              <div className="mt-[18px] grid gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label
                      htmlFor="first-run-server-name"
                      className="font-mono text-[9.5px] tracking-[0.1em] text-muted-foreground uppercase"
                    >
                      Name
                    </Label>
                    <Input
                      id="first-run-server-name"
                      className="h-10 border-border bg-card text-[12px] shadow-none"
                      value={serverName}
                      onChange={(event) => setServerName(event.target.value)}
                    />
                  </div>
                  <label className="grid gap-1.5 font-mono text-[9.5px] tracking-[0.1em] text-muted-foreground uppercase">
                    Transport
                    <select
                      className="h-10 rounded-md border border-border bg-card px-3 font-sans text-[12px] tracking-normal text-foreground normal-case shadow-none outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                      value={serverTransport}
                      onChange={(event) =>
                        setServerTransport(
                          event.target.value as "http" | "stdio",
                        )
                      }
                    >
                      <option value="http">HTTP / SSE</option>
                      <option value="stdio">stdio</option>
                    </select>
                  </label>
                </div>

                <div className="grid gap-1.5">
                  <Label
                    htmlFor="first-run-server-details-url"
                    className="font-mono text-[9.5px] tracking-[0.1em] text-muted-foreground uppercase"
                  >
                    Server URL or command
                  </Label>
                  <Input
                    id="first-run-server-details-url"
                    className="h-10 border-border bg-card font-mono text-[11.5px] shadow-none"
                    spellCheck={false}
                    value={serverUrlOrCommand}
                    onChange={(event) =>
                      setServerUrlOrCommand(event.target.value)
                    }
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1.5 font-mono text-[9.5px] tracking-[0.1em] text-muted-foreground uppercase">
                    Authentication
                    <select
                      className="h-10 rounded-md border border-border bg-card px-3 font-sans text-[12px] tracking-normal text-foreground normal-case shadow-none outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                      value={serverAuthentication}
                      onChange={(event) =>
                        setServerAuthentication(
                          event.target
                            .value as FirstRunServerDraft["authentication"],
                        )
                      }
                    >
                      <option value="auto">Auto</option>
                      <option value="oauth">OAuth</option>
                      <option value="bearer">Bearer token</option>
                      <option value="none">None</option>
                    </select>
                  </label>
                  <div className="grid gap-1.5">
                    <Label
                      htmlFor="first-run-server-header"
                      className="font-mono text-[9.5px] tracking-[0.1em] text-muted-foreground uppercase"
                    >
                      Header
                    </Label>
                    <Input
                      id="first-run-server-header"
                      className="h-10 border-border bg-card font-mono text-[11.5px] shadow-none"
                      placeholder="X-Api-Key"
                      value={serverHeader}
                      onChange={(event) => setServerHeader(event.target.value)}
                    />
                  </div>
                </div>
              </div>

              <Button
                type="submit"
                className="mt-4 h-auto w-full rounded-md px-4 py-2.5 text-[12.5px] font-semibold shadow-none"
              >
                Connect server
              </Button>
              <Button
                type="button"
                variant="link"
                className="mx-auto mt-3 h-auto p-1 text-[11px] font-normal text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-primary"
                onClick={() => setStep("choose")}
              >
                Back
              </Button>
            </form>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function deriveServerName(urlOrCommand: string): string {
  const withoutProtocol = urlOrCommand.replace(/^[a-z]+:\/\//i, "");
  const firstToken = withoutProtocol.split(/\s+/)[0] || "server";
  const hostname = firstToken.split("/")[0].replace(/^mcp\./i, "");
  const name = hostname.split(".")[0].replace(/[-_]+/g, " ");
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Server";
}

const CONNECTION_PROGRESS_STEPS = [
  "Reach server",
  "Negotiate MCP compatibility",
  "Load tools",
] as const;

function ConnectionProgress({
  status,
  prefersReducedMotion,
}: {
  status: "preparing" | "connecting" | "loading-tools";
  prefersReducedMotion: boolean | null;
}) {
  const activeIndex = status === "loading-tools" ? 2 : 0;
  const completedThrough = status === "loading-tools" ? 1 : -1;

  return (
    <ol className="mt-5 grid gap-2.5" aria-label="Connection progress">
      {CONNECTION_PROGRESS_STEPS.map((label, index) => {
        const isComplete = index <= completedThrough;
        const isActive = index === activeIndex;
        return (
          <li
            key={label}
            className="flex items-center gap-3 rounded-md border border-border bg-muted/25 px-3 py-2.5 text-left"
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
              {isComplete ? (
                <Check className="size-4 text-success" aria-hidden />
              ) : isActive ? (
                <Loader2
                  className={cn(
                    "size-4 text-primary",
                    !prefersReducedMotion && "animate-spin",
                  )}
                  aria-hidden
                />
              ) : (
                <Circle className="size-3" aria-hidden />
              )}
            </span>
            <span
              className={cn(
                "text-[12px] leading-5",
                isComplete || isActive
                  ? "font-medium text-card-foreground"
                  : "text-muted-foreground",
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
