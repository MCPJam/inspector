import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useReducedMotion } from "framer-motion";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ExternalLink } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Dialog, DialogPortal } from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import {
  trackFirstRunConnectionFailed,
  trackFirstRunOnboardingEntered,
  trackFirstRunOnboardingScreenViewed,
  trackFirstRunSetupLater,
  type FirstRunOnboardingScreen,
} from "@/lib/first-run-onboarding-analytics";
import { FIRST_RUN_OAUTH_OVERLAY_READY_EVENT } from "@/lib/first-run-oauth-return";
import type { GuestSessionRefusalReason } from "@/lib/guest-session";
import { guestSessionRefusalCopy } from "@/lib/guest-session-refusal-copy";
import {
  AuthorizationProgress,
  ConnectionProgress,
} from "./FirstRunConnectionProgress";
import {
  FirstRunFrame,
  FirstRunHeading,
  FirstRunSkipRow,
  ServerTile,
} from "./FirstRunFrame";
import { ConnectionFailureNotice } from "./FirstRunNotices";
import {
  FirstRunConnectedScreen,
  FirstRunConnectScreen,
  FirstRunDemoFailedScreen,
  type FirstRunToolPreview,
} from "./FirstRunScreens";
import {
  useFirstRunServerForm,
  type FirstRunServerDraft,
} from "./use-first-run-server-form";

export type { FirstRunServerDraft } from "./use-first-run-server-form";
export type { FirstRunToolPreview } from "./FirstRunScreens";

export const FIRST_RUN_CONNECTION_SUCCESS_REVEAL_MS = 800;

type FirstRunOverlayStep =
  | "choose"
  | "connecting"
  | "authorizing"
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
      status: "authorization-required";
      serverName: string;
      serverKind: FirstRunServerKind;
      error?: string;
    }
  | {
      status: "connected";
      serverName: string;
      serverKind: FirstRunServerKind;
      toolCount: number | null;
      /** The first few tools, when discovery returned them this session. */
      toolPreview?: readonly FirstRunToolPreview[];
    }
  | {
      status: "failed";
      serverName: string;
      serverKind: FirstRunServerKind;
      error: string;
    };

/** The step a non-idle connection state forces; `null` leaves the user's step alone. */
function stepForConnectionState(
  connectionState: FirstRunConnectionState,
): FirstRunOverlayStep | null {
  switch (connectionState.status) {
    case "preparing":
    case "connecting":
    case "loading-tools":
      return "connecting";
    case "authorization-required":
      return "authorizing";
    case "connected":
      return "connected";
    case "failed":
      return connectionState.serverKind === "demo"
        ? "demo-failed"
        : "server-details";
    default:
      return null;
  }
}

function analyticsScreenForStep(
  step: FirstRunOverlayStep,
  connectionState: FirstRunConnectionState,
): FirstRunOnboardingScreen {
  if (step === "connected") return "connected";
  if (step === "demo-failed") return "demo_failure";
  if (step === "server-details") return "personal_server_details";
  if (step === "connecting" || step === "authorizing") {
    if (connectionState.status === "preparing") return "project_preparing";
    if (connectionState.status === "loading-tools") return "loading_tools";
    return "connecting";
  }
  return "server_choice";
}

interface FirstRunOnboardingOverlayProps {
  open: boolean;
  connectionState: FirstRunConnectionState;
  recoveryServerDraft?: FirstRunServerDraft;
  onConnectOwnServer: (draft: FirstRunServerDraft) => void;
  onConnectDemo: () => void;
  onAuthorizeConnection: (draft: FirstRunServerDraft) => void;
  onCancelConnection: () => void;
  onReturnToChoice: () => void;
  onOpenPlayground: () => void;
  isOpeningPlayground?: boolean;
  /** Called while onboarding is visible, so a reload resumes it. */
  onShown: () => void;
  onSkip: () => void;
  /** Why the backend refused a guest session, or null while one is allowed. */
  guestSessionRefusal?: GuestSessionRefusalReason | null;
  onSignIn?: () => void;
  organizationId?: string | null;
  isSignedIn?: boolean;
}

/**
 * The Home-mounted, full-page shell for first-run onboarding.
 *
 * It owns initial URL capture, sign-in, and editable failure recovery.
 * The parent sends each draft through the existing save-and-connect path, then
 * reports the real connection outcome back here for the next visible state.
 */
export function FirstRunOnboardingOverlay({
  open,
  connectionState,
  recoveryServerDraft,
  onConnectOwnServer,
  onConnectDemo,
  onAuthorizeConnection,
  onCancelConnection,
  onReturnToChoice,
  onOpenPlayground,
  isOpeningPlayground = false,
  onShown,
  onSkip,
  guestSessionRefusal = null,
  onSignIn,
  organizationId,
  isSignedIn,
}: FirstRunOnboardingOverlayProps) {
  const prefersReducedMotion = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<FirstRunOverlayStep>("choose");
  const [visibleCompletedConnectionSteps, setVisibleCompletedConnectionSteps] =
    useState(connectionState.status === "connected" ? 3 : 0);
  const [isConnectedPresentationReady, setIsConnectedPresentationReady] =
    useState(connectionState.status === "connected");
  const presentedServerNameRef = useRef<string | null>(
    connectionState.status === "idle" ? null : connectionState.serverName,
  );
  const hasObservedConnectionProgressRef = useRef(
    connectionState.status !== "idle" && connectionState.status !== "connected",
  );
  const pacedConnectedServerRef = useRef<string | null>(null);
  const previousConnectionStatusRef = useRef(connectionState.status);
  const idleDestinationRef = useRef<"choose" | "server-details" | null>(null);
  const wasOpenRef = useRef(false);
  const lastTrackedScreenRef = useRef<FirstRunOnboardingScreen | null>(null);
  const {
    serverUrlOrCommand,
    setServerUrlOrCommand,
    serverUrlError,
    setServerUrlError,
    serverName,
    setServerName,
    serverTransport,
    setServerTransport,
    serverAuthentication,
    xaaConfigurationError,
    resetServerDraft,
    validateSelectedAuthentication,
    buildServerDraft,
    authenticationSection,
  } = useFirstRunServerForm({
    open,
    connectionStatus: connectionState.status,
    recoveryServerDraft,
    organizationId,
    isSignedIn,
    contentRef,
  });

  useEffect(() => {
    if (open) onShown();
  }, [onShown, open]);

  const returnToChoice = useCallback(() => {
    onReturnToChoice();
    resetServerDraft();
    setStep("choose");
  }, [onReturnToChoice, resetServerDraft]);

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
      // The choice screen starts a new server connection. Always derive its
      // identity from the URL entered here instead of reusing a name hydrated
      // from an earlier OAuth recovery attempt.
      const inferredName = deriveServerName(trimmedUrlOrCommand);
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
    [
      onConnectOwnServer,
      serverUrlOrCommand,
      setServerName,
      setServerTransport,
      setServerUrlError,
      setServerUrlOrCommand,
    ],
  );

  useLayoutEffect(() => {
    if (!open) return;
    if (
      connectionState.status !== "preparing" &&
      connectionState.status !== "connecting" &&
      connectionState.status !== "loading-tools" &&
      connectionState.status !== "authorization-required" &&
      connectionState.status !== "connected"
    ) {
      return;
    }
    window.dispatchEvent(new Event(FIRST_RUN_OAUTH_OVERLAY_READY_EVENT));
  }, [connectionState.status, open]);

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
      if (!validateSelectedAuthentication()) return;
      onConnectOwnServer(
        buildServerDraft(
          serverName.trim() || deriveServerName(trimmedUrlOrCommand),
          trimmedUrlOrCommand,
        ),
      );
    },
    [
      buildServerDraft,
      onConnectOwnServer,
      serverAuthentication,
      serverName,
      serverTransport,
      serverUrlOrCommand,
      setServerUrlError,
      setServerUrlOrCommand,
      validateSelectedAuthentication,
    ],
  );

  const authorizeWithSelectedSettings = useCallback(() => {
    if (!validateSelectedAuthentication()) return;
    onAuthorizeConnection(
      buildServerDraft(
        serverName.trim() ||
          (connectionState.status === "authorization-required"
            ? connectionState.serverName
            : deriveServerName(serverUrlOrCommand)),
        serverUrlOrCommand,
      ),
    );
  }, [
    buildServerDraft,
    connectionState,
    onAuthorizeConnection,
    serverName,
    serverUrlOrCommand,
    validateSelectedAuthentication,
  ]);

  useEffect(() => {
    if (!open) return;
    if (
      connectionState.status === "preparing" ||
      connectionState.status === "connecting" ||
      connectionState.status === "loading-tools"
    ) {
      setStep("connecting");
    } else if (connectionState.status === "authorization-required") {
      setStep("authorizing");
    } else if (connectionState.status === "connected") {
      setStep(isConnectedPresentationReady ? "connected" : "connecting");
    } else if (connectionState.status === "failed") {
      setStep(
        connectionState.serverKind === "demo"
          ? "demo-failed"
          : "server-details",
      );
    }
  }, [connectionState, isConnectedPresentationReady, open]);

  useEffect(() => {
    const previousStatus = previousConnectionStatusRef.current;
    previousConnectionStatusRef.current = connectionState.status;
    if (
      open &&
      connectionState.status === "idle" &&
      previousStatus !== "idle"
    ) {
      const destination = idleDestinationRef.current ?? "choose";
      idleDestinationRef.current = null;
      if (destination === "choose") {
        resetServerDraft();
      }
      setStep(destination);
    }
  }, [connectionState.status, open, resetServerDraft]);

  // A fast local or cached connection can otherwise jump from one spinner
  // straight to the success screen. Pace only the presentation: the real
  // handshake and tool discovery continue at full speed underneath. This also
  // keeps the same page mounted across an OAuth return.
  useEffect(() => {
    if (!open || connectionState.status === "idle") return;
    const serverName = connectionState.serverName;
    const isProgressState =
      connectionState.status === "preparing" ||
      connectionState.status === "connecting" ||
      connectionState.status === "loading-tools";

    if (isProgressState) {
      hasObservedConnectionProgressRef.current = true;
      if (presentedServerNameRef.current !== serverName) {
        presentedServerNameRef.current = serverName;
        pacedConnectedServerRef.current = null;
        setVisibleCompletedConnectionSteps(0);
        setIsConnectedPresentationReady(false);
      }
      if (connectionState.status !== "loading-tools") return;
      setVisibleCompletedConnectionSteps((count) => Math.max(count, 2));
      return;
    }

    if (connectionState.status !== "connected") return;
    presentedServerNameRef.current = serverName;
    if (pacedConnectedServerRef.current === serverName) return;
    pacedConnectedServerRef.current = serverName;
    if (!hasObservedConnectionProgressRef.current) {
      setVisibleCompletedConnectionSteps(3);
      setIsConnectedPresentationReady(true);
      return;
    }
    if (prefersReducedMotion) {
      setVisibleCompletedConnectionSteps(3);
      setIsConnectedPresentationReady(true);
      return;
    }

    setIsConnectedPresentationReady(false);
    const firstId = window.setTimeout(
      () => setVisibleCompletedConnectionSteps((count) => Math.max(count, 1)),
      100,
    );
    const secondId = window.setTimeout(
      () => setVisibleCompletedConnectionSteps((count) => Math.max(count, 2)),
      250,
    );
    const thirdId = window.setTimeout(
      () => setVisibleCompletedConnectionSteps(3),
      400,
    );
    let revealCompleted = false;
    const revealId = window.setTimeout(() => {
      revealCompleted = true;
      setIsConnectedPresentationReady(true);
    }, FIRST_RUN_CONNECTION_SUCCESS_REVEAL_MS);
    return () => {
      window.clearTimeout(firstId);
      window.clearTimeout(secondId);
      window.clearTimeout(thirdId);
      window.clearTimeout(revealId);
      if (!revealCompleted) pacedConnectedServerRef.current = null;
    };
  }, [connectionState, open, prefersReducedMotion]);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      lastTrackedScreenRef.current = null;
      return;
    }
    // A restored connection state reaches `step` one render late; recording
    // the stale step would log a screen the user never saw.
    const forcedStep = stepForConnectionState(connectionState);
    if (forcedStep && forcedStep !== step) return;

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

  const cancelToStep = (destination: "choose" | "server-details") => {
    idleDestinationRef.current = destination;
    onCancelConnection();
    setStep(destination);
  };

  const serverTarget =
    serverUrlOrCommand.trim() ||
    recoveryServerDraft?.urlOrCommand ||
    (connectionState.status !== "idle" && connectionState.serverKind === "demo"
      ? "Excalidraw sample server"
      : "Your MCP server");
  const signsInWithOAuth =
    serverTransport === "http" &&
    (serverAuthentication === "auto" ||
      serverAuthentication === "oauth" ||
      serverAuthentication === "xaa");

  let content: ReactNode;
  if (
    step === "authorizing" &&
    connectionState.status === "authorization-required"
  ) {
    content = (
      <>
        <FirstRunHeading
          tile={<ServerTile name={connectionState.serverName} />}
          title={`Sign in to ${connectionState.serverName}`}
          description={serverTarget}
        />
        <p className="mt-7 max-w-prose text-base leading-relaxed">
          {signsInWithOAuth
            ? "This server needs authorization. MCPJam takes you to its sign-in page, then finishes connecting when you come back."
            : "This server needs authorization. Add your credentials below, then connect."}
        </p>
        {connectionState.error ? (
          <ConnectionFailureNotice
            title="Authorization didn't finish"
            error={connectionState.error}
          />
        ) : null}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="lg"
            className="h-12 font-semibold"
            onClick={authorizeWithSelectedSettings}
          >
            {signsInWithOAuth ? "Continue to sign-in" : "Connect"}
            {signsInWithOAuth ? <ExternalLink aria-hidden /> : null}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="h-12"
            onClick={() => cancelToStep("server-details")}
          >
            Edit server details
          </Button>
        </div>
        {serverTransport === "http" ? (
          <div className="mt-8 rounded-lg bg-card">
            {authenticationSection}
          </div>
        ) : null}
        {xaaConfigurationError ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {xaaConfigurationError}
          </p>
        ) : null}
        <AuthorizationProgress />
      </>
    );
  } else if (
    step === "connecting" &&
    (connectionState.status === "preparing" ||
      connectionState.status === "connecting" ||
      connectionState.status === "loading-tools" ||
      (connectionState.status === "connected" && !isConnectedPresentationReady))
  ) {
    content = guestSessionRefusal ? (
      <>
        <FirstRunHeading
          title="Sign in to continue"
          description={guestSessionRefusalCopy(guestSessionRefusal).summary}
        />
        <Button
          type="button"
          size="lg"
          className="mt-8 h-12 font-semibold"
          onClick={onSignIn}
        >
          Sign in
        </Button>
      </>
    ) : (
      <>
        {connectionState.status === "preparing" ? (
          <FirstRunHeading
            title="Preparing your MCPJam workspace"
            description="Getting your project ready to connect to an MCP server."
          />
        ) : (
          <FirstRunHeading
            tile={<ServerTile name={connectionState.serverName} />}
            title={`Connecting to ${connectionState.serverName}`}
            description={serverTarget}
          />
        )}
        <ConnectionProgress
          status={connectionState.status}
          prefersReducedMotion={prefersReducedMotion}
          completedSteps={visibleCompletedConnectionSteps}
        />
        {connectionState.status !== "connected" ? (
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="mt-6 h-12"
            onClick={() => cancelToStep("choose")}
          >
            Cancel
          </Button>
        ) : null}
      </>
    );
  } else if (step === "connected" && connectionState.status === "connected") {
    content = (
      <FirstRunConnectedScreen
        serverName={connectionState.serverName}
        toolCount={connectionState.toolCount}
        toolPreview={connectionState.toolPreview}
        animate={!prefersReducedMotion}
        isOpeningPlayground={isOpeningPlayground}
        onOpenPlayground={onOpenPlayground}
      />
    );
  } else if (step === "demo-failed" && connectionState.status === "failed") {
    content = (
      <FirstRunDemoFailedScreen
        error={connectionState.error}
        onRetry={onConnectDemo}
        onConnectOwnServer={returnToChoice}
        onSkip={setUpLater}
      />
    );
  } else if (step === "server-details") {
    content = (
      <form onSubmit={submitServerDetails}>
        <FirstRunHeading
          title={
            connectionState.status === "failed"
              ? `Couldn't connect to ${connectionState.serverName}`
              : "Edit server details"
          }
          description={
            connectionState.status === "failed"
              ? "Check the details below and try again."
              : "Change how MCPJam connects to your server."
          }
        />
        {connectionState.status === "failed" ? (
          <ConnectionFailureNotice
            title="Connection error"
            error={connectionState.error}
          />
        ) : null}

        <div className="mt-8 grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor="first-run-server-details-url" className="text-sm">
              Server URL or command
            </Label>
            <Input
              id="first-run-server-details-url"
              className="h-12 bg-card font-mono md:text-base"
              spellCheck={false}
              value={serverUrlOrCommand}
              aria-invalid={serverUrlError ? true : undefined}
              onChange={(event) => {
                setServerUrlOrCommand(event.target.value);
                if (serverUrlError) setServerUrlError(null);
              }}
            />
            {serverUrlError ? (
              <p className="text-sm text-destructive" role="alert">
                {serverUrlError}
              </p>
            ) : null}
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="first-run-server-name" className="text-sm">
                Name
              </Label>
              <Input
                id="first-run-server-name"
                className="h-11 bg-card md:text-base"
                value={serverName}
                onChange={(event) => setServerName(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label id="first-run-transport-label" className="text-sm">
                Transport
              </Label>
              <ToggleGroup
                type="single"
                variant="outline"
                size="lg"
                className="w-full bg-card"
                aria-labelledby="first-run-transport-label"
                value={serverTransport}
                onValueChange={(value) => {
                  if (value === "http" || value === "stdio") {
                    setServerTransport(value);
                  }
                }}
              >
                <ToggleGroupItem value="http">HTTP / SSE</ToggleGroupItem>
                <ToggleGroupItem value="stdio">stdio</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          {serverTransport === "http" ? (
            <div className="rounded-lg bg-card">
              {authenticationSection}
            </div>
          ) : null}
          {xaaConfigurationError ? (
            <p className="text-sm text-destructive" role="alert">
              {xaaConfigurationError}
            </p>
          ) : null}
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-2">
          <Button type="submit" size="lg" className="h-12 font-semibold">
            Try again
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="h-12"
            onClick={returnToChoice}
          >
            Start over
          </Button>
          <Button
            type="button"
            variant="link"
            className="ml-auto px-0 text-sm"
            onClick={onConnectDemo}
          >
            Try the sample server instead
          </Button>
        </div>
        <FirstRunSkipRow onSkip={setUpLater} />
      </form>
    );
  } else {
    content = (
      <FirstRunConnectScreen
        serverUrlOrCommand={serverUrlOrCommand}
        serverUrlError={serverUrlError}
        onServerUrlOrCommandChange={(value) => {
          setServerUrlOrCommand(value);
          if (serverUrlError) setServerUrlError(null);
        }}
        onSubmit={connectWithInitialDefaults}
        onConnectDemo={onConnectDemo}
        onSkip={setUpLater}
        guestSessionRefusal={guestSessionRefusal}
        onSignIn={onSignIn}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onSkip()}>
      <DialogPortal>
        <DialogPrimitive.Content
          ref={contentRef}
          className="fixed inset-0 z-50 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <FirstRunFrame>{content}</FirstRunFrame>
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
