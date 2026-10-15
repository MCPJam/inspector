import { describe, expect, it } from "vitest";
import {
  describeWebSearchRefusal,
  webSearchPolicyNote,
  webSearchRefusalCodeOf,
} from "../web-search-refusal";

describe("webSearchRefusalCodeOf", () => {
  it("reads the code the server kept on a refused search", () => {
    expect(
      webSearchRefusalCodeOf("web_search", {
        error: "Web search is off for this organization.",
        code: "org_runtime_unsupported",
      }),
    ).toBe("org_runtime_unsupported");
  });

  it("ignores other tools, results that ran, and codes it does not know", () => {
    expect(
      webSearchRefusalCodeOf("bash", { code: "org_runtime_unsupported" }),
    ).toBeUndefined();
    expect(
      webSearchRefusalCodeOf("web_search", { results: [] }),
    ).toBeUndefined();
    expect(
      webSearchRefusalCodeOf("web_search", {
        error: "Web search failed (500).",
      }),
    ).toBeUndefined();
    expect(
      webSearchRefusalCodeOf("web_search", { code: "something_new" }),
    ).toBeUndefined();
    expect(webSearchRefusalCodeOf("web_search", null)).toBeUndefined();
  });
});

describe("describeWebSearchRefusal", () => {
  it("keeps the required key policy on when search is unsupported", () => {
    const admin = describeWebSearchRefusal("org_runtime_unsupported", "admin");
    expect(admin.title).toBe("Web search is off");
    expect(admin.body).toContain("Keep “Use your keys for all AI features” on");
    expect(admin.body).not.toContain("turn off");
    const member = describeWebSearchRefusal(
      "org_runtime_unsupported",
      "member",
    );
    expect(member.title).toBe("Web search is off");
    expect(member.body).toBe(admin.body);
    expect(member.body).not.toContain("Organization → AI providers");
    expect(member.remediation).toBe("unsupported");
  });

  it("gives a visitor one neutral sentence", () => {
    expect(
      describeWebSearchRefusal("org_runtime_unsupported", "visitor"),
    ).toMatchObject({
      title: "Web search unavailable",
      body: "Web search isn't available in this chat.",
    });
  });

  it("asks for the organization's search model when none is set", () => {
    expect(
      describeWebSearchRefusal("org_model_unconfigured", "admin"),
    ).toMatchObject({
      title: "Web search needs a search model",
      body: "Choose the organization's search model in Organization → AI providers to turn web search on.",
    });
    expect(
      describeWebSearchRefusal("org_model_unconfigured", "member").body,
    ).toBe(
      "Ask an organization admin to choose a search model in Organization → AI providers.",
    );
  });

  it("reads the model codes as the organization's model, never a pick", () => {
    const described = describeWebSearchRefusal("capability_missing", "admin");
    expect(described.title).toBe("Web search unavailable");
    expect(described.remediation).toBe("configure_org_model_role");
  });
});

describe("webSearchPolicyNote", () => {
  const readiness = (status: string, requireOrgKeys = true) => ({
    requireOrgKeys,
    operations: [{ operation: "web_search", status }],
  });

  it("notes search that can't run under the policy", () => {
    expect(webSearchPolicyNote(readiness("unsupported"))).toBe(
      "Off while your organization requires its own AI keys. Web search can't run on them yet.",
    );
    expect(webSearchPolicyNote(readiness("unconfigured"))).toBe(
      "Needs a search model. Choose one in Organization → AI providers.",
    );
    expect(webSearchPolicyNote(readiness("invalid_credentials"))).toContain(
      "Check Organization → AI providers",
    );
  });

  it("says nothing when search runs, the policy is off, or the backend reports no row", () => {
    expect(webSearchPolicyNote(readiness("ready"))).toBeUndefined();
    expect(webSearchPolicyNote(readiness("hosted", false))).toBeUndefined();
    expect(
      webSearchPolicyNote(readiness("unsupported", false)),
    ).toBeUndefined();
    expect(
      webSearchPolicyNote({ requireOrgKeys: true, operations: [] }),
    ).toBeUndefined();
    expect(webSearchPolicyNote(undefined)).toBeUndefined();
  });
});
