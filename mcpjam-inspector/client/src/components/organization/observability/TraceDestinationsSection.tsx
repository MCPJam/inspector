import { useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import { Switch } from "@mcpjam/design-system/switch";
import { PauseCircle, PlayCircle, Plus, Send, Trash2 } from "lucide-react";
import { useProjectQueries } from "@/hooks/useProjects";
import {
  useOrgTraceDestinations,
  useTraceDestinationsAvailability,
  type TraceDestination,
} from "@/hooks/useOrgTraceDestinations";
import { SOURCE_TYPE_OPTIONS } from "./presets";
import { TraceDestinationDialog } from "./TraceDestinationDialog";

/**
 * Where this organization's traces are streamed.
 *
 * SELF-ENFORCES AVAILABILITY, like the Slack and Discord sections do: the nav
 * strip already hides the entry, but someone who types
 * `/organizations/:id/observability` bypasses the strip entirely. The check is
 * the SERVER's answer (`traceDestinations:getAvailability`), not the client
 * flag the strip reads — a client flag is an advertising decision and this is
 * an access one.
 *
 * MUST BE RENDERED INSIDE AN `ErrorBoundary`. Its hooks re-throw query errors
 * during render; see the docblock on `useOrgTraceDestinations`.
 */

interface TraceDestinationsSectionProps {
  organizationId: string;
  /** Org admin or owner. Members get a read-only view. */
  isAdmin: boolean;
}

export function TraceDestinationsSection({
  organizationId,
  isAdmin,
}: TraceDestinationsSectionProps) {
  const { isAuthenticated } = useConvexAuth();
  const availability = useTraceDestinationsAvailability(organizationId);
  const {
    destinations,
    isLoading,
    error,
    isSaving,
    createDestination,
    updateDestination,
    deleteDestination,
    setEnabled,
    pauseDestination,
    resumeDestination,
    sendTestSpan,
    startBackfill,
  } = useOrgTraceDestinations(organizationId);
  const { sortedProjects } = useProjectQueries({
    isAuthenticated,
    organizationId,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TraceDestination | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TraceDestination | null>(
    null,
  );

  const projects = useMemo(
    () => sortedProjects.map((p) => ({ id: p._id, name: p.name })),
    [sortedProjects],
  );

  // `undefined` is "not asked yet", never "no". Rendering nothing while the
  // answer is in flight is right; treating it as `disabled` would blank the
  // page for an admin who cold-loads this URL.
  if (availability === undefined) return null;

  // A RESOLVED "no" gets a sentence, not a blank page. The nav strip decides
  // whether to advertise this section from the CLIENT flag, which knows
  // nothing about this particular organization — so a flagged-in admin whose
  // org the server has not covered can click a real tab and arrive here. An
  // empty page reads as a broken screen; saying so reads as an answer.
  if (availability.state !== "enabled") {
    return (
      <Card className="space-y-2 p-6">
        <h2 className="text-base font-semibold">Trace destinations</h2>
        <p className="text-sm text-muted-foreground">
          {availability.state === "unavailable"
            ? "You are not a member of this organization."
            : "Streaming traces to an observability vendor is not enabled for this organization yet. Traces are still exportable on demand from any completed run."}
        </p>
      </Card>
    );
  }

  const canEdit = isAdmin && availability.canEdit;

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Trace destinations</h2>
          <p className="text-sm text-muted-foreground">
            Stream this organization&apos;s traces to an OTLP/HTTP endpoint as
            they happen. Content is redacted unless a destination opts in.
          </p>
        </div>
        {canEdit ? (
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" />
            New destination
          </Button>
        ) : null}
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading destinations…</p>
      ) : destinations && destinations.length > 0 ? (
        <ul className="space-y-3">
          {destinations.map((destination) => (
            <DestinationRow
              key={destination.id}
              destination={destination}
              canEdit={canEdit}
              isSaving={isSaving}
              onEdit={() => {
                setEditing(destination);
                setDialogOpen(true);
              }}
              onDelete={() => setPendingDelete(destination)}
              onToggleEnabled={(next) => setEnabled(destination.id, next)}
              onPause={() => pauseDestination(destination.id)}
              onResume={() => resumeDestination(destination.id)}
              onTest={() => sendTestSpan(destination.id)}
              onBackfill={(days) => startBackfill(destination.id, days)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No destinations yet. Traces are still exportable on demand from a run
          — a destination is what makes them continuous.
        </p>
      )}

      <TraceDestinationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        destination={editing}
        projects={projects}
        isSaving={isSaving}
        error={error}
        onSubmit={async (input) => {
          if (editing) {
            await updateDestination(editing.id, input);
          } else {
            // `allProjects` is update-only and the dialog does not emit it on
            // a create. Destructured off rather than cast away, so the day it
            // reappears here the compiler says so instead of Convex.
            const { allProjects: _allProjects, ...createInput } = input;
            await createDestination(createInput);
          }
          setDialogOpen(false);
        }}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Streaming stops immediately and anything still queued for this
              destination is discarded. Traces already delivered stay in the
              vendor&apos;s system — MCPJam cannot retract them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (pendingDelete) await deleteDestination(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/**
 * Why a destination stopped, said in terms of what to do about it.
 *
 * The backend's reasons are machine names; an admin needs the remedy. An
 * unrecognized reason falls through to the raw value rather than a generic
 * apology — a name we did not anticipate is still more useful than "something
 * went wrong".
 */
function pausedExplanation(reason: string): string {
  switch (reason) {
    case "manual":
      return "Paused by an admin. Nothing is queued while a destination is paused.";
    case "auth_failed":
      return "The vendor rejected the credentials (401/403). Update the headers, then resume.";
    case "secret_unreadable":
      return "MCPJam could not decrypt the stored headers. Re-enter them, then resume.";
    case "redirect_required":
      return "The endpoint answered with a redirect. MCPJam never follows one — point the destination at the final URL.";
    case "permanent_failures":
      return "The vendor refused several deliveries in a row for a reason retrying cannot fix. Check the endpoint and headers, then resume.";
    default:
      return reason;
  }
}

function healthLabel(destination: TraceDestination): {
  text: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  if (destination.paused)
    return { text: "Paused", variant: "destructive" as const };
  if (!destination.enabled)
    return { text: "Disabled", variant: "outline" as const };
  const health = destination.health;
  if (!health || health.lastAttemptAt === null)
    return { text: "No deliveries yet", variant: "secondary" as const };
  if (health.lastDeliveryStatus === "success")
    return { text: "Delivering", variant: "default" as const };
  if (health.lastDeliveryStatus === "retrying")
    return { text: "Retrying", variant: "secondary" as const };
  return {
    text: health.lastDeliveryStatus ?? "Unknown",
    variant: "destructive" as const,
  };
}

function DestinationRow({
  destination,
  canEdit,
  isSaving,
  onEdit,
  onDelete,
  onToggleEnabled,
  onPause,
  onResume,
  onTest,
  onBackfill,
}: {
  destination: TraceDestination;
  canEdit: boolean;
  isSaving: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (next: boolean) => void;
  onPause: () => void;
  onResume: () => Promise<number | null>;
  onTest: () => void;
  onBackfill: (days: number) => void;
}) {
  const [pausedSince, setPausedSince] = useState<number | null>(null);
  const elapsedDays =
    pausedSince === null
      ? 0
      : Math.max(1, Math.ceil((Date.now() - pausedSince) / 86_400_000));
  const backfillDays = Math.min(30, elapsedDays);
  const cappedAtThirtyDays = elapsedDays > 30;
  const badge = healthLabel(destination);
  const health = destination.health;

  let host = destination.endpointUrl;
  try {
    host = new URL(destination.endpointUrl).host;
  } catch {
    // A stored URL that no longer parses is worth showing verbatim rather than
    // hiding — it is the reason deliveries are failing.
  }

  const sourceLabels = destination.sourceTypes.map(
    (id) => SOURCE_TYPE_OPTIONS.find((o) => o.id === id)?.label ?? id,
  );

  return (
    <li className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{destination.name}</span>
            <Badge variant={badge.variant}>{badge.text}</Badge>
            {destination.includeContent ? (
              <Badge variant="outline">Content included</Badge>
            ) : (
              <Badge variant="outline">Redacted</Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">{host}</p>
        </div>
        {canEdit ? (
          <div className="flex items-center gap-1">
            <Switch
              aria-label={`Enable ${destination.name}`}
              checked={destination.enabled}
              onCheckedChange={onToggleEnabled}
              disabled={isSaving}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={onTest}
              disabled={isSaving}
            >
              <Send className="mr-1 h-3.5 w-3.5" />
              Send test span
            </Button>
            {destination.paused ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => setPausedSince(await onResume())}
                disabled={isSaving}
              >
                <PlayCircle className="mr-1 h-3.5 w-3.5" />
                Resume
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={onPause}
                disabled={isSaving}
              >
                <PauseCircle className="mr-1 h-3.5 w-3.5" />
                Pause
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onEdit}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${destination.name}`}
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1">
        {sourceLabels.map((label) => (
          <Badge key={label} variant="secondary">
            {label}
          </Badge>
        ))}
      </div>

      {destination.paused ? (
        <Alert variant="destructive">
          <AlertTitle>Paused</AlertTitle>
          <AlertDescription>
            {pausedExplanation(destination.paused.reason)}
          </AlertDescription>
        </Alert>
      ) : null}

      {pausedSince !== null ? (
        <Alert>
          <AlertTitle>Resumed</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              Nothing was queued while this destination was paused. Backfill if
              you need those traces.
            </p>
            {canEdit ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onBackfill(backfillDays);
                    setPausedSince(null);
                  }}
                >
                  Backfill the last {backfillDays}{" "}
                  {backfillDays === 1 ? "day" : "days"}
                </Button>
                {/*
                  THE BUTTON SAYS DAYS BECAUSE THE BACKFILL TAKES DAYS. A
                  whole-day granularity cannot express "the two hours you were
                  paused", and rounding UP is the right direction — a backfill
                  that stops short leaves exactly the gap this exists to close
                  — but it means re-sending traces that already arrived.
                  Delivery is at-least-once and span ids are deterministic, so
                  the vendor sees the same spans again rather than duplicates
                  of different ones. Saying the real number beats a label that
                  implies an exactness the API does not offer.
                */}
                {cappedAtThirtyDays ? (
                  <p className="text-xs">
                    This destination was paused for longer than 30 days, which
                    is the furthest a backfill reaches. Anything older stays
                    missing.
                  </p>
                ) : null}
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {destination.lastTest ? (
        <p className="text-xs text-muted-foreground">
          Last test: {destination.lastTest.status}
          {destination.lastTest.error ? ` — ${destination.lastTest.error}` : ""}
        </p>
      ) : null}

      {health ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
          <Stat label="Queued">
            {health.pendingCount}
            {health.pendingCountCapped ? "+" : ""}
          </Stat>
          <Stat label="Sessions delivered">{health.deliveredSessionCount}</Stat>
          <Stat label="Spans delivered">{health.deliveredSpanCount}</Stat>
          <Stat label="Dropped">{health.deadLetterCount}</Stat>
        </dl>
      ) : null}

      {health?.lastDeliveryError ? (
        <p className="text-xs text-destructive">
          Last error
          {health.lastHttpStatus
            ? ` (HTTP ${health.lastHttpStatus})`
            : ""}: {health.lastDeliveryError}
        </p>
      ) : null}
    </li>
  );
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  );
}
