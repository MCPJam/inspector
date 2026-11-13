/**
 * Declarations nobody has stood behind yet. A portal default, an imported
 * value or one a reconnect reset is listed; one somebody set or confirmed is
 * not, and a field that is not a declaration never is.
 */

import { describe, expect, it } from "vitest";

import {
  CLAUDE_CONNECTOR_FLOW as FLOW,
  unconfirmedDeclarations,
  type DirectoryAnswer,
} from "../../src/directory-readiness/index.js";

describe("unconfirmedDeclarations", () => {
  it("lists every declaration of an empty draft, defaults with their value", () => {
    expect(unconfirmedDeclarations(FLOW, [])).toEqual([
      {
        key: "useCases.access",
        step: "useCases",
        label: "Read/write capabilities",
        origin: "default",
        value: "read-only",
      },
      {
        key: "dataHandling.apiOwnership",
        step: "dataHandling",
        label: "API ownership",
        origin: "default",
        value: "own",
      },
      {
        key: "dataHandling.healthData",
        step: "dataHandling",
        label: "Personal health data",
        origin: "default",
        value: "no",
      },
      {
        key: "dataHandling.sponsored",
        step: "dataHandling",
        label: "Sponsored content",
      },
      {
        key: "testLaunch.selfTested",
        step: "testLaunch",
        label: "Self-tested",
      },
      {
        key: "compliance.acknowledgments",
        step: "compliance",
        label: "Policies acknowledged",
      },
    ]);
  });

  it("drops what someone set or confirmed, and keeps what nobody did", () => {
    const answers: DirectoryAnswer[] = [
      { key: "useCases.access", value: "read-write", origin: "set" },
      { key: "dataHandling.apiOwnership", value: "own", origin: "confirmed" },
      { key: "dataHandling.healthData", value: "no", origin: "imported" },
      { key: "dataHandling.sponsored", value: "no", origin: "set" },
      { key: "testLaunch.selfTested", value: false, origin: "reset" },
      { key: "compliance.acknowledgments", value: [], origin: "set" },
    ];
    expect(
      unconfirmedDeclarations(FLOW, answers).map(({ key, origin }) => [
        key,
        origin,
      ])
    ).toEqual([
      ["dataHandling.healthData", "imported"],
      ["testLaunch.selfTested", "reset"],
    ]);
  });

  it("never lists a field that is not a declaration", () => {
    // Authentication defaults too, but choosing it attests nothing.
    const keys = unconfirmedDeclarations(FLOW, []).map((entry) => entry.key);
    expect(keys).not.toContain("authentication.requirement");
    for (const key of keys) {
      const field = FLOW.steps
        .flatMap((step) => step.fields)
        .find((entry) => entry.key === key);
      expect(field?.declaration, key).toBe(true);
    }
  });
});
