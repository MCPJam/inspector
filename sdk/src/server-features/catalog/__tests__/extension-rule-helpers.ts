/** Shared lookups for the extension catalog tests (families 18 to 24). */

import type {
  DeclaredSurface,
  FeatureDefinition,
  ProbeSummary,
  ProbeSurface,
  ServerProbeId,
} from "../../types.js";
import { EXTENSION_FEATURES } from "../extensions/index.js";

export const MODERN = "2026-07-28";
export const TASKS_CORE_VERSION = "2025-11-25";
export const TASKS_EXT = "io.modelcontextprotocol/tasks";
export const SKILLS_EXT = "io.modelcontextprotocol/skills";

export const plainTool = { name: "search", inputSchema: { type: "object" } };

export type ProbeValues<P extends ServerProbeId> = ProbeSummary<P>["values"];
export type ProbeOverrides<P extends ServerProbeId> = Partial<
  Omit<ProbeSummary<P>, "probeId" | "values">
>;

export function feature(id: string): FeatureDefinition {
  const found = EXTENSION_FEATURES.find((entry) => entry.id === id);
  if (!found) throw new Error(`No catalog feature ${id}`);
  return found;
}

export function declared(id: string, surface: DeclaredSurface) {
  const rule = feature(id).assessment.declared;
  if (!rule) throw new Error(`${id} has no declared rule`);
  return rule(surface);
}

export function probed(id: string, probes: ProbeSurface) {
  const rule = feature(id).assessment.probed;
  if (!rule) throw new Error(`${id} has no probed rule`);
  return rule(probes);
}
