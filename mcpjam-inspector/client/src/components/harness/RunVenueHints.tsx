import { useConvexAuth } from "convex/react";
import { useHost } from "@/hooks/useClients";
import { useProjectEnvironment } from "@/hooks/useProjectEnvironments";
import {
  useUnattendedHarnessVenue,
  type UnattendedVenue,
} from "@/hooks/useUnattendedHarnessVenue";
import { ExecutionTargetChip } from "@/components/chat-v2/chat-input/execution-target-chip";

function Venue({ venue, name }: { venue: UnattendedVenue; name?: string }) {
  return (
    <ExecutionTargetChip
      readOnly
      harnessName={name}
      target={
        venue === "local"
          ? "local-native"
          : venue === "hosted"
          ? "hosted"
          : null
      }
      phase={
        venue === "checking"
          ? "loading"
          : venue === "unavailable"
          ? "unavailable"
          : "ready"
      }
      hostedAvailable={venue === "checking" ? null : venue === "hosted"}
    />
  );
}

function HarnessVenue({
  projectId,
  harnessId,
  name,
}: {
  projectId: string;
  harnessId: string;
  name: string;
}) {
  const venue = useUnattendedHarnessVenue(projectId, harnessId);
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <span>{name}</span>
      <Venue venue={venue} name={name} />
    </span>
  );
}

function ClientVenue({
  projectId,
  hostId,
}: {
  projectId: string;
  hostId: string;
}) {
  const { isAuthenticated } = useConvexAuth();
  const { host, isLoading } = useHost({ isAuthenticated, hostId });
  if (isLoading) return <Venue venue="checking" />;
  if (!host) return <Venue venue="unavailable" />;
  const harness = host.config.harness;
  if (harness !== "claude-code" && harness !== "codex") return null;
  return (
    <HarnessVenue projectId={projectId} harnessId={harness} name={host.name} />
  );
}

function EnvironmentVenue({
  projectId,
  environmentId,
}: {
  projectId: string;
  environmentId: string;
}) {
  const environment = useProjectEnvironment(projectId, environmentId);
  if (environment === undefined) return <Venue venue="checking" />;
  if (!environment || environment.archivedAt !== undefined)
    return <Venue venue="unavailable" />;
  return <ClientVenue projectId={projectId} hostId={environment.hostId} />;
}

/** Resolve the same environment-first target axis as run launch, including ad-hoc rows. */
export function RunVenueHints({
  projectId,
  environmentIds,
  hostIds,
}: {
  projectId?: string;
  environmentIds?: readonly string[] | null;
  hostIds?: readonly string[];
}) {
  if (!projectId) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {environmentIds?.length
        ? [...new Set(environmentIds)].map((id) => (
            <EnvironmentVenue
              key={id}
              projectId={projectId}
              environmentId={id}
            />
          ))
        : [...new Set(hostIds)].map((id) => (
            <ClientVenue key={id} projectId={projectId} hostId={id} />
          ))}
    </span>
  );
}
