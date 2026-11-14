/**
 * The first-run screens that depend on connection and authentication state:
 * sign-in, connecting, and server details. The overlay passes values and
 * callbacks in.
 */
import type { FormEvent, ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import type { GuestSessionRefusalReason } from "@/lib/guest-session";
import { guestSessionRefusalCopy } from "@/lib/guest-session-refusal-copy";
import {
  AuthorizationProgress,
  ConnectionProgress,
} from "./FirstRunConnectionProgress";
import { FirstRunHeading, FirstRunSkipRow, ServerTile } from "./FirstRunFrame";
import { ConnectionFailureNotice } from "./FirstRunNotices";

type ServerTransport = "http" | "stdio";

/** The authentication fields, shown only for HTTP servers. */
function AuthenticationFields({
  serverTransport,
  authenticationSection,
  xaaConfigurationError,
}: {
  serverTransport: ServerTransport;
  authenticationSection: ReactNode;
  xaaConfigurationError: string | null;
}) {
  return (
    <>
      {serverTransport === "http" ? (
        <div className="rounded-lg bg-card">{authenticationSection}</div>
      ) : null}
      {xaaConfigurationError ? (
        <p className="text-sm text-destructive" role="alert">
          {xaaConfigurationError}
        </p>
      ) : null}
    </>
  );
}

export function FirstRunAuthorizingScreen({
  serverName,
  serverTarget,
  signsInWithOAuth,
  error,
  onAuthorize,
  onEditDetails,
  serverTransport,
  authenticationSection,
  xaaConfigurationError,
}: {
  serverName: string;
  serverTarget: string;
  signsInWithOAuth: boolean;
  error?: string;
  onAuthorize: () => void;
  onEditDetails: () => void;
  serverTransport: ServerTransport;
  authenticationSection: ReactNode;
  xaaConfigurationError: string | null;
}) {
  return (
    <>
      <FirstRunHeading
        tile={<ServerTile name={serverName} />}
        title={`Sign in to ${serverName}`}
        description={serverTarget}
      />
      <p className="mt-7 max-w-prose text-base leading-relaxed">
        {signsInWithOAuth
          ? "This server needs authorization. MCPJam takes you to its sign-in page, then finishes connecting when you come back."
          : "This server needs authorization. Add your credentials below, then connect."}
      </p>
      {error ? (
        <ConnectionFailureNotice
          title="Authorization didn't finish"
          error={error}
        />
      ) : null}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button type="button" size="xl" onClick={onAuthorize}>
          {signsInWithOAuth ? "Continue to sign-in" : "Connect"}
          {signsInWithOAuth ? <ExternalLink aria-hidden /> : null}
        </Button>
        <Button type="button" variant="ghost" size="xl" onClick={onEditDetails}>
          Edit server details
        </Button>
      </div>
      <div className="mt-8 grid gap-3">
        <AuthenticationFields
          serverTransport={serverTransport}
          authenticationSection={authenticationSection}
          xaaConfigurationError={xaaConfigurationError}
        />
      </div>
      <AuthorizationProgress />
    </>
  );
}

export function FirstRunConnectingScreen({
  status,
  serverName,
  serverTarget,
  prefersReducedMotion,
  completedSteps,
  guestSessionRefusal,
  onSignIn,
  onCancel,
}: {
  status: "preparing" | "connecting" | "loading-tools" | "connected";
  serverName: string;
  serverTarget: string;
  prefersReducedMotion: boolean | null;
  completedSteps: number;
  guestSessionRefusal: GuestSessionRefusalReason | null;
  onSignIn?: () => void;
  onCancel: () => void;
}) {
  if (guestSessionRefusal) {
    return (
      <>
        <FirstRunHeading
          title="Sign in to continue"
          description={guestSessionRefusalCopy(guestSessionRefusal).summary}
        />
        <Button type="button" size="xl" className="mt-8" onClick={onSignIn}>
          Sign in
        </Button>
      </>
    );
  }
  return (
    <>
      {status === "preparing" ? (
        <FirstRunHeading
          title="Preparing your MCPJam workspace"
          description="Getting your project ready to connect to an MCP server."
        />
      ) : (
        <FirstRunHeading
          tile={<ServerTile name={serverName} />}
          title={`Connecting to ${serverName}`}
          description={serverTarget}
        />
      )}
      <ConnectionProgress
        status={status}
        prefersReducedMotion={prefersReducedMotion}
        completedSteps={completedSteps}
      />
      {status !== "connected" ? (
        <Button
          type="button"
          variant="ghost"
          size="xl"
          className="mt-6"
          onClick={onCancel}
        >
          Cancel
        </Button>
      ) : null}
    </>
  );
}

export interface FirstRunServerDetailsFields {
  serverUrlOrCommand: string;
  serverUrlError: string | null;
  onServerUrlOrCommandChange: (value: string) => void;
  serverName: string;
  onServerNameChange: (value: string) => void;
  serverTransport: ServerTransport;
  onServerTransportChange: (value: ServerTransport) => void;
  authenticationSection: ReactNode;
  xaaConfigurationError: string | null;
}

function ServerDetailsFields({
  serverUrlOrCommand,
  serverUrlError,
  onServerUrlOrCommandChange,
  serverName,
  onServerNameChange,
  serverTransport,
  onServerTransportChange,
  authenticationSection,
  xaaConfigurationError,
}: FirstRunServerDetailsFields) {
  return (
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
          onChange={(event) => onServerUrlOrCommandChange(event.target.value)}
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
            onChange={(event) => onServerNameChange(event.target.value)}
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
                onServerTransportChange(value);
              }
            }}
          >
            <ToggleGroupItem value="http">HTTP / SSE</ToggleGroupItem>
            <ToggleGroupItem value="stdio">stdio</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <AuthenticationFields
        serverTransport={serverTransport}
        authenticationSection={authenticationSection}
        xaaConfigurationError={xaaConfigurationError}
      />
    </div>
  );
}

export function FirstRunServerDetailsScreen({
  failure,
  onSubmit,
  onStartOver,
  onConnectDemo,
  onSkip,
  ...fields
}: FirstRunServerDetailsFields & {
  failure: { serverName: string; error: string } | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStartOver: () => void;
  onConnectDemo: () => void;
  onSkip: () => void;
}) {
  return (
    <form onSubmit={onSubmit}>
      <FirstRunHeading
        title={
          failure
            ? `Couldn't connect to ${failure.serverName}`
            : "Edit server details"
        }
        description={
          failure
            ? "Check the details below and try again."
            : "Change how MCPJam connects to your server."
        }
      />
      {failure ? (
        <ConnectionFailureNotice
          title="Details from the failed connection"
          error={failure.error}
        />
      ) : null}

      <ServerDetailsFields {...fields} />

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <Button type="submit" size="xl">
          Try again
        </Button>
        <Button type="button" variant="ghost" size="xl" onClick={onStartOver}>
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
      <FirstRunSkipRow onSkip={onSkip} />
    </form>
  );
}
