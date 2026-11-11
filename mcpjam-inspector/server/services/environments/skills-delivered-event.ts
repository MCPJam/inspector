/**
 * The skills-delivered event: one per turn, in counts. It says how many skills
 * the turn's engine was handed, by family; how many the plan left out, by
 * reason; how many failed to arrive; and whether delivery went as planned
 * (`outcome`). Feature health watches the share of turns that report `failed`.
 *
 * Counts and closed vocabularies only. A skill's name, id, ref or content never
 * rides the event: they are a customer's own words, and the strict server
 * schema (`shared/strict-server-analytics.ts`) drops every field it does not
 * declare.
 *
 * The event is personless. Health needs counts, not people, and most reports
 * have no person to name: an eval iteration carries no request identity, and a
 * scheduled or GitHub-check run never had one.
 */
import { randomUUID } from "node:crypto";
import { captureServerEventForActor } from "../../utils/analytics.js";
import type { EffectiveCapabilitySet } from "./effective-capabilities.js";
import type {
  SkillExclusionReason,
  SkillRef,
  TurnSkills,
  TurnSkillsResult,
} from "./turn-skills.js";

/**
 * Where the turn ran. A surface joins when its turns plan with
 * `resolveTurnSkills`: add it here and to `surface` in the strict schema, then
 * report each turn with {@link reportSkillsDelivered}.
 */
export type SkillsDeliveredSurface = "eval";

type SkillFamily = "library" | "plugin" | "mcp-server" | "local";

const DELIVERED_FIELD = {
  library: "delivered_library_count",
  plugin: "delivered_plugin_count",
  "mcp-server": "delivered_mcp_server_count",
  local: "delivered_local_count",
} as const satisfies Record<SkillFamily, string>;

const EXCLUDED_FIELD = {
  "unsupported-harness": "excluded_unsupported_harness_count",
  "server-skill-unsupported": "excluded_server_skill_unsupported_count",
  "plugin-disabled": "excluded_plugin_disabled_count",
  "name-collision": "excluded_name_collision_count",
  "invalid-skill-name": "excluded_invalid_skill_name_count",
  "over-cap": "excluded_over_cap_count",
} as const satisfies Record<SkillExclusionReason, string>;

// Every count rides every event, zeros included, so an insight never has to
// read a missing field as zero.
const COUNT_FIELDS = [
  ...Object.values(DELIVERED_FIELD),
  "omitted_from_catalog_count",
  ...Object.values(EXCLUDED_FIELD),
  "failed_count",
];

/** A personless event still needs a distinct id: one per process. */
const DISTINCT_ID = randomUUID();

/**
 * Report one turn's skills: its plan and, once the turn knows it, what
 * happened. Without a result the plan counts as having arrived whole.
 *
 * `outcome` compares what arrived with the plan: `ok` when nothing failed,
 * `partial` when some skills arrived and some failed, `failed` when none
 * arrived. A skill the plan left out is counted under its reason, never as a
 * failure. A skill MCPJam's agent left off its prompt's skill list did arrive,
 * since its tools load it by name; `omitted_from_catalog_count` says how many
 * of the delivered those are. A turn with no skills reports nothing: it is not
 * a delivery attempt, and counting it would bury every failure under turns
 * that never had a skill.
 */
export function reportSkillsDelivered(
  surface: SkillsDeliveredSurface,
  skills: TurnSkills,
  result: TurnSkillsResult = { delivered: skills.delivered, failed: [] },
): void {
  const attempted =
    skills.delivered.length + skills.excluded.length + result.failed.length;
  if (attempted === 0) return;
  const counts = zeroCounts();
  const familyOf = skillFamilies(skills.set);
  for (const ref of result.delivered) {
    counts[DELIVERED_FIELD[familyOf(ref)]] += 1;
    if (ref.omittedFromCatalog) counts.omitted_from_catalog_count += 1;
  }
  for (const { reason } of skills.excluded) counts[EXCLUDED_FIELD[reason]] += 1;
  counts.failed_count = result.failed.length;
  const outcome =
    result.failed.length === 0
      ? "ok"
      : result.delivered.length > 0
        ? "partial"
        : "failed";
  capture({
    surface,
    outcome,
    runtime: skills.runtime.kind,
    ...(skills.runtime.kind === "harness"
      ? { harness_id: skills.runtime.harnessId }
      : {}),
    ...counts,
  });
}

/**
 * Report a run that stopped before its first model call because its frozen
 * skills could not be delivered: none of its `skillCount` skills reached an
 * engine. No engine had been chosen yet, so the event names none.
 */
export function reportSkillsUndelivered(
  surface: SkillsDeliveredSurface,
  skillCount: number,
): void {
  if (skillCount === 0) return;
  capture({
    surface,
    outcome: "failed",
    ...zeroCounts(),
    failed_count: skillCount,
  });
}

function capture(properties: Record<string, string | number>): void {
  // A unit test that runs an eval must not send this event to PostHog.
  if (process.env.VITEST) return;
  captureServerEventForActor({ distinctId: DISTINCT_ID }, "skills_delivered", {
    ...properties,
    $process_person_profile: false,
  });
}

/**
 * A skill's family is the list of the turn's set that holds it. Library is the
 * family with no origin of its own, so it also takes a skill the set does not
 * hold: one whose ref another skill already holds, which the bare-name tools
 * still serve by name.
 */
function skillFamilies(
  set: EffectiveCapabilitySet,
): (ref: SkillRef) => SkillFamily {
  const families = new Map<string, SkillFamily>([
    ...set.pluginSkills.map((skill) => [skill.skillId, "plugin"] as const),
    ...set.serverSkills.map((skill) => [skill.skillId, "mcp-server"] as const),
    ...set.localSkills.map((skill) => [skill.skillId, "local"] as const),
  ]);
  return (ref) => families.get(ref.skillId) ?? "library";
}

function zeroCounts(): Record<string, number> {
  return Object.fromEntries(COUNT_FIELDS.map((field) => [field, 0]));
}
