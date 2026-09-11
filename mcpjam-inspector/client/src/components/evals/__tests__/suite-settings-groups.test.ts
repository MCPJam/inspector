import { describe, expect, it } from "vitest";
import {
  EVAL_SUITE_SETTING_KEYS,
  EVAL_SUITE_SETTINGS_MANIFEST,
  SETTINGS_PAGE_HIDDEN_KEYS,
} from "@/shared/eval-suite-settings-manifest";
import {
  NESTED_SETTING_KEYS,
  SUITE_SETTINGS_GROUPS,
  SUITE_SETTINGS_HEADER_KEYS,
} from "../suite-settings-groups";

describe("SUITE_SETTINGS_GROUPS", () => {
  it("places every visible manifest key exactly once across header keys, rows and nested keys", () => {
    const placed: string[] = [...SUITE_SETTINGS_HEADER_KEYS];
    for (const group of SUITE_SETTINGS_GROUPS) {
      for (const row of group.rows) {
        placed.push(row);
        const nested = NESTED_SETTING_KEYS[row] ?? [];
        placed.push(...nested);
      }
    }
    expect(placed).toEqual([...new Set(placed)]);
    const visibleKeys = EVAL_SUITE_SETTINGS_MANIFEST.filter(
      (row) => !(row.key in SETTINGS_PAGE_HIDDEN_KEYS),
    ).map((row) => row.key);
    const missing = visibleKeys.filter((key) => !placed.includes(key));
    const unknown = placed.filter(
      (key) => !EVAL_SUITE_SETTING_KEYS.includes(key as never),
    );
    expect(missing, `manifest keys with no group placement: ${missing.join(", ")}`).toEqual(
      [],
    );
    expect(unknown, `unknown keys in groups: ${unknown.join(", ")}`).toEqual([]);
  });
});
