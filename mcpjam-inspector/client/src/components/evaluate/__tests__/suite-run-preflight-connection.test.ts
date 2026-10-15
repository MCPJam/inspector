import { describe, expect, it } from "vitest";
import {
  orgKeyProblemsOf,
  type PreflightOrgConfig,
} from "../suite-run-preflight-org-keys";

const config: PreflightOrgConfig = {
  providers: [
    {
      id: "approved",
      providerKey: "openai",
      enabled: true,
      hasSecret: true,
      policyEligibility: { eligible: true },
    },
  ],
};

describe("explicit organization connection preflight", () => {
  it.each([undefined, "", "missing"])(
    "refuses unresolved connection %s",
    (id) => {
      expect(
        orgKeyProblemsOf(config, [
          {
            model: "gpt-5",
            provider: "openai",
            selection: {
              source: "org",
              connectionRef: { kind: "orgProvider", id },
            },
          },
        ]),
      ).toHaveLength(1);
    },
  );

  it("accepts the saved eligible connection", () => {
    expect(
      orgKeyProblemsOf(config, [
        {
          model: "gpt-5",
          provider: "openai",
          selection: {
            source: "org",
            connectionRef: { kind: "orgProvider", id: "approved" },
          },
        },
      ]),
    ).toEqual([]);
  });
});
