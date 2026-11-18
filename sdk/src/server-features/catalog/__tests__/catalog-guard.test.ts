/**
 * CI guard over the whole feature catalog (core and extensions). It holds
 * while the extensions half is empty and keeps holding once it is filled:
 * family-specific assertions here cover families 1–17 only.
 */

import { describe, expect, it } from "vitest";
import { MCP_PROTOCOL_VERSIONS } from "../../../mcp-client-manager/mcp-protocol-version.js";
import { CHECK_FEATURE_MAPS } from "../../check-map/index.js";
import { FEATURE_FAMILY_IDS } from "../../types.js";
import { SERVER_FEATURE_CATALOG } from "../index.js";
import {
  CORE_REVISIONS,
  compareCoreRevisions,
  isCoreRevision,
} from "../revisions.js";
import { SPEC_PINS } from "../spec-refs.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9.\-]{0,95}$/;
const CATALOG = SERVER_FEATURE_CATALOG;
const IDS = new Set(CATALOG.map((feature) => feature.id));

describe("catalog ids and tree", () => {
  it("gives every entry a unique id the backend accepts", () => {
    const seen = new Set<string>();
    for (const feature of CATALOG) {
      expect(feature.id, feature.id).toMatch(ID_PATTERN);
      expect(seen.has(feature.id), `duplicate id ${feature.id}`).toBe(false);
      seen.add(feature.id);
    }
  });

  it("puts each parent earlier in the array and in the same family", () => {
    const position = new Map(
      CATALOG.map((feature, index) => [feature.id, index])
    );
    CATALOG.forEach((feature, index) => {
      if (!feature.parent) return;
      const parentIndex = position.get(feature.parent) ?? -1;
      expect(
        parentIndex,
        `${feature.id} names a missing parent`
      ).toBeGreaterThanOrEqual(0);
      expect(parentIndex < index, `${feature.id} precedes its parent`).toBe(
        true
      );
      expect(CATALOG[parentIndex]?.family, feature.id).toBe(feature.family);
    });
  });

  it("uses only known families", () => {
    for (const feature of CATALOG) {
      expect(FEATURE_FAMILY_IDS, feature.id).toContain(feature.family);
    }
  });
});

describe("catalog entries", () => {
  it("has a name, summary, how-to and pinned https spec link", () => {
    for (const feature of CATALOG) {
      const label = feature.id;
      expect(feature.name.trim(), label).not.toBe("");
      expect(feature.summary.trim(), label).not.toBe("");
      expect(feature.howTo.trim(), label).not.toBe("");
      expect(new URL(feature.spec.url).protocol, label).toBe("https:");
      expect(feature.spec.pin, label).toBe(SPEC_PINS[feature.spec.source]);
      expect(feature.spec.checkedAt, label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("keeps user-facing text free of dashes used as punctuation", () => {
    for (const feature of CATALOG) {
      for (const text of [feature.name, feature.summary, feature.howTo]) {
        expect(text, feature.id).not.toMatch(/[–—]/);
      }
    }
  });

  it("names only known revisions, in order, in each lifecycle", () => {
    for (const feature of CATALOG) {
      const { introduced, deprecated, removed } = feature.lifecycle;
      const named = [introduced, deprecated, removed].filter(
        (version): version is string => version !== undefined
      );
      for (const version of named) {
        expect(isCoreRevision(version), `${feature.id}: ${version}`).toBe(true);
      }
      if (introduced && deprecated) {
        expect(
          compareCoreRevisions(introduced, deprecated),
          feature.id
        ).toBeLessThanOrEqual(0);
      }
      if (introduced && removed) {
        expect(
          compareCoreRevisions(introduced, removed),
          feature.id
        ).toBeLessThan(0);
      }
      if (deprecated && removed) {
        expect(
          compareCoreRevisions(deprecated, removed),
          feature.id
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  it("gives every set-up feature a setup kind", () => {
    for (const feature of CATALOG) {
      if (feature.assessment.primary === "configured") {
        expect(feature.assessment.setup, feature.id).toBeDefined();
      }
    }
  });
});

describe("protocol revisions", () => {
  it("lists revisions oldest first", () => {
    expect([...CORE_REVISIONS].sort()).toEqual([...CORE_REVISIONS]);
  });

  it("knows every protocol version MCPJam can pin", () => {
    for (const version of MCP_PROTOCOL_VERSIONS) {
      expect(isCoreRevision(version), version).toBe(true);
    }
  });
});

describe("check maps", () => {
  it("maps only to features that exist", () => {
    for (const [suite, map] of Object.entries(CHECK_FEATURE_MAPS)) {
      for (const [checkId, target] of Object.entries(map)) {
        if (target === undefined || target === "excluded") continue;
        expect(target.length, `${suite}:${checkId}`).toBeGreaterThan(0);
        for (const featureId of target) {
          expect(IDS.has(featureId), `${suite}:${checkId} → ${featureId}`).toBe(
            true
          );
        }
      }
    }
  });
});
