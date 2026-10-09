import {
  entitiesFromResult,
  GROUNDING_LIMITS,
  parseJsonReport,
  record,
  exactIdentity,
  type SetupRecord,
  type SetupEntity,
} from "../../../shared/swarm-grounding";
export function parseSetupReport(text: string) {
  const obj = record(parseJsonReport(text));
  if (
    !obj ||
    typeof obj.ready !== "boolean" ||
    !Array.isArray(obj.created) ||
    !Array.isArray(obj.missing)
  )
    return undefined;
  if (
    obj.created.length > 25 ||
    obj.missing.length > 25 ||
    obj.created.some((c) => !record(c)) ||
    obj.missing.some((m) => !record(m))
  )
    return undefined;
  return {
    ready: obj.ready,
    created: obj.created as Record<string, unknown>[],
    missing: obj.missing as Record<string, unknown>[],
  };
}
export function deriveCreatedEntities(args: {
  modelReport: ReturnType<typeof parseSetupReport>;
  setup: SetupRecord;
  toolResults: Map<number, unknown>;
}) {
  const all: SetupEntity[] = [];
  const seen = new Set<string>();
  for (const [callIndex, output] of args.toolResults) {
    const call = args.setup.toolCalls[callIndex];
    if (!call?.ok || !call.isWrite || !call.dispatched) continue;
    for (const { objectPath, ...entity } of entitiesFromResult(output)) {
      const key = JSON.stringify([
        call.serverId,
        call.toolName,
        entity.id ?? entity.name,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        ...entity,
        serverId: call.serverId,
        tool: call.toolName,
        evidence: { callIndex, objectPath },
        ...(entity.name && !entity.name.startsWith(args.setup.prefix)
          ? { unprefixed: true }
          : {}),
      });
    }
  }
  let unsupportedClaims = 0;
  for (const claim of args.modelReport?.created ?? []) {
    const matches = all.filter(
      (e) =>
        (!claim.tool || claim.tool === e.tool) &&
        (claim.id !== undefined
          ? claim.id === e.id &&
            (claim.name === undefined || claim.name === e.name)
          : claim.name === e.name && !!e.name),
    );
    if (matches.length !== 1) unsupportedClaims++;
  }
  return {
    createdEntities: all.slice(0, GROUNDING_LIMITS.entities),
    observedCreatedEntityCount: all.length,
    ...(all.length > GROUNDING_LIMITS.entities
      ? { createdEntitiesTruncated: true }
      : {}),
    unsupportedClaims,
    missing: (args.modelReport?.missing ?? []).map((m) => ({
      kind: exactIdentity(m.kind) ?? "entity",
      why: exactIdentity(m.why) ?? "Prerequisite unavailable",
    })),
  };
}
export function judgeReadiness(
  setup: SetupRecord,
  report: ReturnType<typeof parseSetupReport>,
): Pick<SetupRecord, "readiness" | "reason"> {
  if (setup.status === "skipped" && setup.reason === "no_eligible_write_tools")
    return { readiness: "not_assessed", reason: setup.reason };
  const reason = !report
    ? "invalid_model_report"
    : !report.ready || report.missing.length
    ? "model_reported_missing"
    : setup.unsupportedClaims
    ? "unsupported_claim"
    : setup.createdEntitiesTruncated
    ? "entity_record_limit"
    : setup.toolCalls.some((c) => c.isWrite && !c.ok)
    ? "write_errored"
    : undefined;
  if (reason) return { readiness: "unavailable", reason };
  if (setup.writeCallsDispatched === 0 && report!.created.length === 0)
    return { readiness: "not_needed" };
  return setup.writeCallsDispatched > 0
    ? { readiness: "ready" }
    : { readiness: "unavailable", reason: "unsupported_claim" };
}
