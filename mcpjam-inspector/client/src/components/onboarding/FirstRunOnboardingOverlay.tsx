import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
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
import {
  AlertCircle,
  Check,
  ChevronDown,
  Circle,
  Loader2,
  X,
} from "lucide-react";
import {
  trackFirstRunConnectionFailed,
  trackFirstRunOnboardingEntered,
  trackFirstRunOnboardingScreenViewed,
  trackFirstRunSetupLater,
  type FirstRunOnboardingScreen,
} from "@/lib/first-run-onboarding-analytics";

/** Time the welcome splash remains visible before it advances to server choice. */
export const FIRST_RUN_WELCOME_AUTO_ADVANCE_MS = 5_500;

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
      toolCount: number | null;
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
  authentication: "auto" | "oauth" | "none";
}

function analyticsScreenForStep(
  step: FirstRunOverlayStep,
  connectionState: FirstRunConnectionState,
): FirstRunOnboardingScreen {
  if (step === "choose") return "server_choice";
  if (step === "connected") return "connected";
  if (step === "demo-failed") return "demo_failure";
  if (step === "server-details") return "personal_server_details";
  if (step === "connecting") {
    if (connectionState.status === "preparing") return "project_preparing";
    if (connectionState.status === "loading-tools") return "loading_tools";
    return "connecting";
  }
  return "welcome";
}

interface FirstRunOnboardingOverlayProps {
  open: boolean;
  skipWelcome?: boolean;
  connectionState: FirstRunConnectionState;
  onConnectOwnServer: (draft: FirstRunServerDraft) => void;
  onConnectDemo: () => void;
  onCancelConnection: () => void;
  onReturnToChoice: () => void;
  onOpenPlayground: () => void;
  onWelcomeShown: () => void;
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
  onReturnToChoice,
  onOpenPlayground,
  onWelcomeShown,
  onSkip,
}: FirstRunOnboardingOverlayProps) {
  const prefersReducedMotion = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);
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
  const wasOpenRef = useRef(false);
  const lastTrackedScreenRef = useRef<FirstRunOnboardingScreen | null>(null);

  useEffect(() => {
    if (open && step === "welcome") onWelcomeShown();
  }, [onWelcomeShown, open, step]);

  const continueToChoice = useCallback(() => {
    setStep("choose");
  }, []);

  const returnToChoice = useCallback(() => {
    onReturnToChoice();
    setStep("choose");
  }, [onReturnToChoice]);

  const connectWithInitialDefaults = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedUrlOrCommand = serverUrlOrCommand.trim();
      if (!trimmedUrlOrCommand) {
        trackFirstRunConnectionFailed({ serverKind: "personal" }, "validation");
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
      });
    },
    [onConnectOwnServer, serverName, serverUrlOrCommand],
  );

  const submitServerDetails = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedUrlOrCommand = serverUrlOrCommand.trim();
      if (!trimmedUrlOrCommand) {
        trackFirstRunConnectionFailed(
          {
            serverKind: "personal",
            transport: serverTransport,
            authentication: serverAuthentication,
          },
          "validation",
        );
        setServerUrlError("Enter a server URL or command.");
        return;
      }

      setServerUrlError(null);
      setServerUrlOrCommand(trimmedUrlOrCommand);
      onConnectOwnServer({
        name: serverName.trim() || deriveServerName(trimmedUrlOrCommand),
        transport: serverTransport,
        urlOrCommand: trimmedUrlOrCommand,
        authentication: serverAuthentication,
      });
    },
    [
      onConnectOwnServer,
      serverAuthentication,
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
    if (!open) {
      wasOpenRef.current = false;
      lastTrackedScreenRef.current = null;
      return;
    }

    const screen = analyticsScreenForStep(step, connectionState);
    if (!wasOpenRef.current) {
      trackFirstRunOnboardingEntered(screen);
      wasOpenRef.current = true;
    }
    if (lastTrackedScreenRef.current !== screen) {
      trackFirstRunOnboardingScreenViewed(screen);
      lastTrackedScreenRef.current = screen;
    }
  }, [connectionState, open, step]);

  const setUpLater = useCallback(() => {
    trackFirstRunSetupLater();
    onSkip();
  }, [onSkip]);

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
              ? "dark bg-background bg-[radial-gradient(ellipse_at_center,var(--background)_0%,var(--background)_42%,transparent_72%),radial-gradient(circle,var(--primary)_1px,transparent_1px)] bg-[size:auto,24px_24px] duration-700"
              : "backdrop-blur-sm"
          }
        />
        <DialogPrimitive.Content
          ref={contentRef}
          className={cn(
            "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg outline-none duration-200 sm:max-w-lg",
            step === "welcome"
              ? "dark max-w-[420px] gap-0 border-0 bg-transparent p-1 text-left shadow-none"
              : "max-h-[calc(100vh-2rem)] max-w-[408px] gap-0 overflow-y-auto rounded-xl border-border bg-card p-6 shadow-none",
          )}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => {
            event.preventDefault();
            if (step === "welcome") continueToChoice();
          }}
        >
          {step === "welcome" ? (
            <>
              <DialogHeader className="gap-0 text-left">
                <div className="flex items-center gap-4">
                  <img
                    src="/mcp_jam.svg"
                    alt=""
                    aria-hidden
                    className="size-14 shrink-0"
                  />
                  <DialogTitle className="max-w-[12ch] pb-0 text-[2rem] leading-[1.12] font-semibold tracking-[-0.038em] text-foreground">
                    Welcome to MCPJam
                  </DialogTitle>
                </div>
                <span
                  className="mt-4 block h-px w-[72px] bg-primary"
                  aria-hidden
                />
                <DialogDescription className="mt-4 max-w-[42ch] text-[14.5px] leading-[1.5] text-foreground">
                  Test and evaluate your MCP server for every user, across every
                  major AI client.
                </DialogDescription>
              </DialogHeader>
              <Button
                type="button"
                className="mt-7 h-auto justify-self-start rounded-md px-4 py-2.5 text-[12.5px] font-semibold shadow-none"
                onClick={continueToChoice}
              >
                Get started
              </Button>
              {!prefersReducedMotion ? (
                <div
                  className="mt-6 h-px w-full overflow-hidden bg-border"
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
              <DialogPrimitive.Close
                className="ring-offset-background focus:ring-ring absolute top-4 right-4 rounded-xs text-muted-foreground opacity-70 transition-opacity hover:text-foreground hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden"
                aria-label="Close onboarding"
              >
                <X className="size-4" aria-hidden />
              </DialogPrimitive.Close>
              <DialogHeader className="gap-0 text-left">
                <DialogTitle className="pb-0 text-[17px] leading-6 font-bold tracking-[-0.02em] text-card-foreground">
                  Connect to your MCP server
                </DialogTitle>
                <DialogDescription className="mt-1 text-[12.5px] leading-[1.55] text-muted-foreground">
                  Add your MCP server to get started, or start testing with our
                  demo server.
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
              </div>
              <Button
                type="button"
                variant="ghost"
                className="mx-auto mt-3 h-auto px-2 py-1 text-[11px] font-normal text-foreground"
                onClick={setUpLater}
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
                variant="ghost"
                className="mx-auto mt-4 h-auto px-2 py-1 text-[11px] font-normal text-foreground"
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
                  <span className="text-card-foreground">
                    {connectionState.serverName}
                  </span>
                </DialogTitle>
                <DialogDescription className="mt-1 text-center text-[12.5px] leading-[1.55] text-muted-foreground">
                  {connectionState.toolCount === null
                    ? "Connected. Tools can finish loading in Playground."
                    : `${connectionState.toolCount} ${
                        connectionState.toolCount === 1 ? "tool" : "tools"
                      } ready to use.`}
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
              <ConnectionFailureNotice
                key={connectionState.error}
                error={connectionState.error}
              />
              <Button
                type="button"
                className="mt-4 h-auto w-full rounded-md px-4 py-2.5 text-[12.5px] font-semibold shadow-none"
                onClick={onConnectDemo}
              >
                Try demo again
              </Button>
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-3 h-auto px-2 py-1 text-[11px] font-normal text-foreground"
                  onClick={returnToChoice}
                >
                  Connect my own server
                </Button>
              </div>
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
                <ConnectionFailureNotice
                  key={connectionState.error}
                  error={connectionState.error}
                />
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
                    aria-invalid={serverUrlError ? true : undefined}
                    onChange={(event) => {
                      setServerUrlOrCommand(event.target.value);
                      if (serverUrlError) setServerUrlError(null);
                    }}
                  />
                  {serverUrlError ? (
                    <p className="text-[10.5px] text-destructive" role="alert">
                      {serverUrlError}
                    </p>
                  ) : null}
                </div>

                <div className="grid gap-1.5">
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
                      <option value="none">None</option>
                    </select>
                  </label>
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
                variant="ghost"
                className="mx-auto mt-3 h-auto px-2 py-1 text-[11px] font-normal text-foreground"
                onClick={returnToChoice}
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

function ConnectionFailureNotice({ error }: { error: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const detailsId = "first-run-connection-error-details";

  return (
    <div
      className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3"
      role="alert"
    >
      <div className="flex items-start gap-2.5">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
          aria-hidden
        >
          <AlertCircle className="size-4" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-[12px] leading-4 font-semibold text-card-foreground">
            Failed to connect to MCP server
          </p>
          <Button
            type="button"
            variant="ghost"
            className="mt-1 h-auto gap-1 px-2 py-1 text-[10.5px] font-normal text-foreground"
            aria-expanded={isExpanded}
            aria-controls={detailsId}
            onClick={() => setIsExpanded((current) => !current)}
          >
            {isExpanded ? "Hide technical details" : "View technical details"}
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                isExpanded && "rotate-180",
              )}
              aria-hidden
            />
          </Button>
        </div>
      </div>
      {isExpanded ? (
        <div className="mt-3 border-t border-destructive/15 pt-3">
          <p
            id={detailsId}
            className="break-words font-mono text-[10.5px] leading-[1.5] text-muted-foreground"
          >
            {error}
          </p>
        </div>
      ) : null}
    </div>
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
