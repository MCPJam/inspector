/**
 * Whether a feature applies at a protocol revision. Lifecycle is per
 * revision, not per era, and a revision the catalog does not know is
 * "unknown-version": today's rules are never applied to a future revision.
 */

import type {
  FeatureApplicability,
  FeatureDefinition,
  FeatureMarker,
} from "./types.js";

/** Every core revision the catalog's lifecycles may name, oldest first. */
export const FEATURE_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
] as const;

function versionIndex(version: string | undefined): number {
  if (!version) return -1;
  return (FEATURE_PROTOCOL_VERSIONS as readonly string[]).indexOf(version);
}

export function isKnownFeatureVersion(version: string | undefined): boolean {
  return versionIndex(version) >= 0;
}

/** True when `version` is the same revision as `boundary` or newer. */
function atOrAfter(version: string, boundary: string): boolean {
  return versionIndex(version) >= versionIndex(boundary);
}

export function featureApplicability(
  feature: Pick<FeatureDefinition, "lifecycle">,
  protocolVersion: string | undefined,
): FeatureApplicability {
  const { introduced, removed } = feature.lifecycle;
  if (!introduced && !removed) return "applies";
  if (!isKnownFeatureVersion(protocolVersion)) return "unknown-version";
  const version = protocolVersion as string;
  if (removed && atOrAfter(version, removed)) return "removed";
  if (introduced && !atOrAfter(version, introduced)) return "not-yet";
  return "applies";
}

/** Deprecated at or before the negotiated revision. */
export function isDeprecatedAt(
  feature: Pick<FeatureDefinition, "lifecycle">,
  protocolVersion: string | undefined,
): boolean {
  const { deprecated } = feature.lifecycle;
  if (!deprecated || !isKnownFeatureVersion(protocolVersion)) return false;
  return atOrAfter(protocolVersion as string, deprecated);
}

export function featureMarkers(
  feature: Pick<FeatureDefinition, "lifecycle" | "stage">,
  protocolVersion: string | undefined,
): FeatureMarker[] {
  const markers: FeatureMarker[] = [];
  if (featureApplicability(feature, protocolVersion) === "removed")
    markers.push("removed");
  else if (isDeprecatedAt(feature, protocolVersion)) markers.push("deprecated");
  if (feature.stage !== "stable") markers.push(feature.stage);
  return markers;
}
