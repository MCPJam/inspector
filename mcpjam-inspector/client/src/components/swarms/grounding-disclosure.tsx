import { useQuery } from "convex/react";
import { SWARM_QUERIES, type JourneyRun } from "@/lib/swarm-api";
import type { TargetGrounding } from "@/shared/swarm-grounding";
export function GroundingDisclosure({
  entries,
  hostName = (id) => id,
}: {
  entries?: TargetGrounding[];
  hostName?: (id: string) => string | undefined;
}) {
  if (!entries?.length) return null;
  const setups = entries.flatMap((entry) => (entry.setup ? [entry.setup] : []));
  const count = setups.reduce(
    (sum, setup) => sum + setup.observedCreatedEntityCount,
    0,
  );
  return (
    <details
      className="rounded-lg border border-border p-3"
      data-testid="swarm-grounding"
    >
      <summary className="cursor-pointer text-sm font-medium">
        What the personas knew
        {setups.length > 0 && (
          <span className="ml-2 text-muted-foreground">
            Setup created {count} entities on {setups.length} targets (not
            cleaned up)
          </span>
        )}
      </summary>
      <div className="mt-3 space-y-3">
        {entries.map((entry) => (
          <details
            key={entry.targetId}
            className="rounded-md border border-border p-3"
          >
            <summary className="cursor-pointer text-sm">
              {hostName(entry.hostId) ?? entry.hostId} · {entry.targetId} ·{" "}
              {entry.status} · {entry.probedTools.length} tools probed
            </summary>
            {entry.facts && (
              <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
                {entry.facts}
              </pre>
            )}
            {!entry.facts && (
              <p className="mt-2 text-sm text-muted-foreground">
                No workspace facts available. {entry.reason}
              </p>
            )}
            {!!entry.unsupportedFacts && (
              <p className="text-sm">
                Discarded {entry.unsupportedFacts} unsupported fact selections.
              </p>
            )}
            {entry.setup && (
              <div className="mt-3 space-y-2 text-sm">
                <p>
                  {entry.setup.readiness === "not_assessed"
                    ? "Setup skipped; prerequisites not assessed"
                    : entry.setup.readiness === "unavailable"
                    ? "Prerequisites unavailable"
                    : entry.setup.readiness === "not_needed"
                    ? "Setup not needed"
                    : "Setup ready"}
                  {entry.setup.reason ? ` · ${entry.setup.reason}` : ""}
                </p>
                <p>
                  Requested prefix: <code>{entry.setup.prefix}</code>. Created
                  data is not cleaned up.
                </p>
                {entry.setup.createdEntitiesTruncated && (
                  <p>
                    {entry.setup.observedCreatedEntityCount} entities observed;
                    showing 25; list incomplete.
                  </p>
                )}
                <ul className="list-inside list-disc">
                  {entry.setup.createdEntities.map((entity, i) => (
                    <li key={i}>
                      {entity.name ?? "(unnamed)"}
                      {entity.id ? ` (${entity.id})` : ""}
                      {entity.unprefixed ? " · unprefixed" : ""} · call{" "}
                      {entity.evidence.callIndex + 1}
                    </li>
                  ))}
                </ul>
                {!!entry.setup.unsupportedClaims && (
                  <p>
                    The model claimed {entry.setup.unsupportedClaims} entities
                    no tool result supports.
                  </p>
                )}
                {entry.setup.missing.map((missing, i) => (
                  <p key={i}>
                    {missing.kind}: {missing.why}
                  </p>
                ))}
                <p>
                  Admitted write tools:{" "}
                  {entry.setup.admittedWriteTools.join(", ") || "none"}
                </p>
                <ol className="list-inside list-decimal">
                  {entry.setup.toolCalls.map((call, i) => (
                    <li key={i}>
                      {call.serverId}/{call.toolName} ·{" "}
                      {call.ok
                        ? "succeeded"
                        : call.dispatched
                        ? "failed or outcome unknown"
                        : "not dispatched"}
                    </li>
                  ))}
                </ol>
                {entry.setup.toolCallsTruncated && (
                  <p>Additional refused calls were omitted from this list.</p>
                )}
              </div>
            )}
          </details>
        ))}
      </div>
    </details>
  );
}
/** Uses the same authorized cached run query as the Run tab; never starts analysis. */
export function RunGroundingDisclosure({ runId }: { runId: string }) {
  const run = useQuery(
    SWARM_QUERIES.getJourneyRun as never,
    { runId } as never,
  ) as JourneyRun | null | undefined;
  return <GroundingDisclosure entries={run?.grounding} />;
}
