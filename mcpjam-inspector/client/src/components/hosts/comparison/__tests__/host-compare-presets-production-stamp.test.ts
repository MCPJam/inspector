import { describe, expect, it, vi } from "vitest";
import {
  bundledHostCompatCatalog,
  type HostCompatCatalog,
} from "@mcpjam/sdk/host-compat";

vi.mock("@/generated/mcpjam-web-deployed-at", () => ({
  MCPJAM_WEB_DEPLOYED_AT: 9_000,
}));

import {
  PRESET_HOST_ID_PREFIX,
  buildPresetCompareEntries,
} from "../host-compare-presets";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("host-compare-presets production deployment stamp", () => {
  it("uses the generated production stamp when the option is omitted", () => {
    const catalog = clone(bundledHostCompatCatalog()) as HostCompatCatalog;
    catalog.hostsById.mcpjam.verifiedAt = 1_000;

    const { subjects } = buildPresetCompareEntries(catalog);

    expect(subjects[`${PRESET_HOST_ID_PREFIX}mcpjam`]?.verifiedAt).toBe(9_000);
  });

  it("uses the catalog date for explicit null despite a production stamp", () => {
    const catalog = clone(bundledHostCompatCatalog()) as HostCompatCatalog;
    const catalogVerifiedAt = 1_000;
    catalog.hostsById.mcpjam.verifiedAt = catalogVerifiedAt;

    const { subjects } = buildPresetCompareEntries(catalog, {
      mcpjamWebDeployedAt: null,
    });

    expect(subjects[`${PRESET_HOST_ID_PREFIX}mcpjam`]?.verifiedAt).toBe(
      catalogVerifiedAt,
    );
  });
});
