import { describe, expect, it } from "vitest";
import {
  buildClearToLegacyPayload,
  buildEnvJourneyPayload,
  compatHostIdsForEnvironments,
} from "../journey-environments";
import type { EnvironmentView } from "@/lib/swarm-api";

const env = (
  environmentId: string,
  hostId: string,
  name = environmentId,
): EnvironmentView => ({
  environmentId,
  projectId: "p",
  name,
  hostId,
  revision: 1,
});

const ENVS = [env("e1", "hostA"), env("e2", "hostB"), env("e3", "hostA")];

describe("compatHostIdsForEnvironments", () => {
  it("resolves hostIds deduped, in selection order", () => {
    expect(compatHostIdsForEnvironments(["e3", "e2", "e1"], ENVS)).toEqual([
      "hostA",
      "hostB",
    ]);
  });

  it("ignores unknown environment ids", () => {
    expect(compatHostIdsForEnvironments(["missing", "e2"], ENVS)).toEqual([
      "hostB",
    ]);
  });
});

describe("buildEnvJourneyPayload", () => {
  it("returns environmentIds + recomputed compat hostIds", () => {
    expect(buildEnvJourneyPayload(["e2", "e1"], ENVS)).toEqual({
      environmentIds: ["e2", "e1"],
      hostIds: ["hostB", "hostA"],
    });
  });

  it("returns null when no env selected or no valid compat host resolves", () => {
    expect(buildEnvJourneyPayload([], ENVS)).toBeNull();
    expect(buildEnvJourneyPayload(["missing"], ENVS)).toBeNull();
  });

  it("rejects the write when any selected id is unresolved (archived/deleted), not just persist the valid ones", () => {
    // "e1" resolves but "missing" does not — the whole write is blocked so a
    // stale archived id can't be persisted alongside valid ones.
    expect(buildEnvJourneyPayload(["e1", "missing"], ENVS)).toBeNull();
  });
});

describe("buildClearToLegacyPayload", () => {
  it("clears environmentIds and recomputes hostIds from the CURRENT env selection", () => {
    expect(buildClearToLegacyPayload(["e1", "e3", "e2"], ENVS)).toEqual({
      environmentIds: null,
      hostIds: ["hostA", "hostB"],
    });
  });

  it("blocks the clear (null) when no valid compat host resolves", () => {
    expect(buildClearToLegacyPayload(["missing"], ENVS)).toBeNull();
    expect(buildClearToLegacyPayload([], ENVS)).toBeNull();
  });
});
