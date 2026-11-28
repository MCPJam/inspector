import { useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@mcpjam/design-system/sheet";
import { Separator } from "@mcpjam/design-system/separator";
import type { RemoteServer } from "@/hooks/useProjects";
import { changeCountLabel } from "./mock-changes";
import { useMockDetails, type MockDetails } from "./use-mock-details";

/** The same query the Servers list reads, so the two share one subscription. */
const getProjectServers = makeFunctionReference<
  "query",
  { projectId: string },
  RemoteServer[]
>("servers:getProjectServers");

type MockServer = RemoteServer & {
  lifecycleScope: "mock";
  // The backend leaves the field out for a mock made from empty, so absent is
  // "no base" as much as null is.
  mock: { baseServerId?: string | null; headVersion: number };
};

const isMock = (server: RemoteServer | undefined): server is MockServer =>
  server?.lifecycleScope === "mock" && server.mock !== undefined;

const ALLOWED_TEXT =
  "Unmatched requests go to the backing server with your access.";
const BLOCKED_TEXT = "Unmatched requests are not sent to the backing server.";
const NO_BACKING_TEXT =
  "This mock has no backing server, so there is nothing to call under either setting.";

/**
 * A button under a mock's name on its card, opening a read-only panel with
 * what the mock changes and the workspace's live-call policy. Renders nothing
 * for an ordinary server or while `mock-servers-enabled` is off.
 */
export function MockMarker({
  projectId,
  serverId,
}: {
  projectId?: string | null;
  serverId?: string;
}) {
  // A literal, so the flag allowlist ratchet sees this read; the key must stay
  // in shared/client-feature-flags.ts or /api/web/flags never returns it.
  const enabled = useFeatureFlagEnabled("mock-servers-enabled") === true;
  if (!enabled || !projectId || !serverId) return null;
  return <MockMarkerForServer projectId={projectId} serverId={serverId} />;
}

function MockMarkerForServer({
  projectId,
  serverId,
}: {
  projectId: string;
  serverId: string;
}) {
  const { isAuthenticated } = useConvexAuth();
  const servers = useQuery(
    getProjectServers,
    isAuthenticated ? { projectId } : "skip"
  );
  const server = servers?.find((candidate) => candidate._id === serverId);
  if (!isMock(server)) return null;
  const base = server.mock.baseServerId
    ? servers?.find((candidate) => candidate._id === server.mock.baseServerId)
    : undefined;
  return <MockMarkerButton server={server} baseName={base?.name ?? null} />;
}

function MockMarkerButton({
  server,
  baseName,
}: {
  server: MockServer;
  baseName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const details = useMockDetails(server._id, server.mock.headVersion, open);
  const hasBase = Boolean(server.mock.baseServerId);
  const count =
    details.status === "ready" ? ` · ${changeCountLabel(details.changes.length)}` : "";
  const label = `${baseName ? `Mock of ${baseName}` : "Mock"}${count}`;

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        {/* A real trigger, so Escape returns focus to the marker. */}
        <SheetTrigger asChild>
          <Badge asChild variant="outline" className="mt-1.5 cursor-pointer">
            <button
              type="button"
              // The card opens its own details on click; this opens the mock's.
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {label}
            </button>
          </Badge>
        </SheetTrigger>
        <SheetContent className="overflow-y-auto" onClick={(event) => event.stopPropagation()}>
          <SheetHeader>
            <SheetTitle>{server.name}</SheetTitle>
            <SheetDescription>This panel is read-only.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-4 px-4 pb-4 text-sm">
            <Field label="Backing server">
              {hasBase ? (baseName ?? "A server no longer in this project") : "None"}
            </Field>
            <Separator />
            <PolicyField details={details} hasBase={hasBase} />
            <Separator />
            <ChangesField details={details} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
      <div className="text-foreground">{children}</div>
    </div>
  );
}

const FAILED_TEXT =
  "Couldn't load this mock's details. Close this panel and open it again.";

function PolicyField({ details, hasBase }: { details: MockDetails; hasBase: boolean }) {
  if (details.status !== "ready") {
    return (
      <Field label="Live calls">
        {details.status === "error" ? FAILED_TEXT : "Loading."}
      </Field>
    );
  }
  const allowed = details.policy === "allow";
  return (
    <Field label="Live calls">
      <div className="flex flex-col gap-1.5">
        <Badge variant={allowed ? "secondary" : "outline"}>
          {allowed ? "Allowed" : "Blocked"}
        </Badge>
        <p className="text-muted-foreground">
          {!hasBase ? NO_BACKING_TEXT : allowed ? ALLOWED_TEXT : BLOCKED_TEXT}
        </p>
      </div>
    </Field>
  );
}

function ChangesField({ details }: { details: MockDetails }) {
  if (details.status !== "ready") {
    return (
      <Field label="Changes">
        {details.status === "error" ? FAILED_TEXT : "Loading."}
      </Field>
    );
  }
  const { changes } = details;
  return (
    <Field label="Changes">
      {changes.length === 0 ? (
        <p className="text-muted-foreground">No changes saved.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {changes.map((change, index) => (
            <li key={`${change.kind}:${change.label}:${index}`} className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{change.kind}</Badge>
              <span className="break-all font-medium">{change.label}</span>
              {change.detail && (
                <span className="break-all text-xs text-muted-foreground">{change.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}
