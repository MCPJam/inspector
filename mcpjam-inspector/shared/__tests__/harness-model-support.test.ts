import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import {
  HARNESS_MODEL_SUPPORT_ROWS,
  HARNESS_PINNED_VERSIONS,
  harnessModelSupport,
  harnessModelSupportAtPinnedVersion,
  harnessModelVerdictAdmits,
  harnessNoRunnableModelReason,
  harnessOrgProviderUnsupportedReason,
  harnessOrgUpstream,
  harnessRunsOnOrgProvider,
  harnessVersionInRange,
  isValidHarnessVersionRange,
  normalizeHarnessModelId,
  parseHarnessVersion,
} from "../harness-model-support";

const PINNED_CODEX = HARNESS_PINNED_VERSIONS.codex;
const PINNED_CLAUDE_CODE = HARNESS_PINNED_VERSIONS["claude-code"];

describe("harnessModelSupport — seed evidence", () => {
  it("claude-code refuses gpt-5.6-luna (Claude Code only runs Anthropic)", () => {
    const verdict = harnessModelSupport({
      harnessId: "claude-code",
      runtimeVersion: PINNED_CLAUDE_CODE,
      modelId: "openai/gpt-5.6-luna",
    });
    expect(verdict.status).toBe("unsupported");
    expect(verdict.reason).toBe(
      "the Claude Code harness can't run this host's model — pick a " +
        "Claude Code-compatible model to run the real runtime",
    );
    expect(verdict.evidence?.familyPattern).toBe(".*");
  });

  it("codex refuses claude-haiku (Codex only runs the gpt-5 family)", () => {
    const verdict = harnessModelSupport({
      harnessId: "codex",
      runtimeVersion: PINNED_CODEX,
      modelId: "anthropic/claude-haiku-4.5",
    });
    expect(verdict.status).toBe("unsupported");
    expect(verdict.reason).toMatch(/Codex harness can't run this host's model/);
  });

  it("claude-code has no verified native id for claude-fable-5", () => {
    const verdict = harnessModelSupport({
      harnessId: "claude-code",
      runtimeVersion: PINNED_CLAUDE_CODE,
      modelId: "anthropic/claude-fable-5",
    });
    expect(verdict.status).toBe("unknown");
    expect(verdict.reason).toBe(
      `not verified for claude-code ${PINNED_CLAUDE_CODE}`,
    );
    expect(verdict.evidence?.familyPattern).toBe("^anthropic/");
  });

  it("codex 0.160 has not been measured on gpt-5.6", () => {
    const verdict = harnessModelSupport({
      harnessId: "codex",
      runtimeVersion: "0.160.0",
      modelId: "openai/gpt-5.6",
    });
    expect(verdict.status).toBe("unknown");
    expect(verdict.reason).toBe("not verified for codex 0.160.0");
  });

  it("codex 0.149.1 runs gpt-5.6 without tools, so it is unsupported", () => {
    const verdict = harnessModelSupport({
      harnessId: "codex",
      runtimeVersion: "0.149.1",
      modelId: "openai/gpt-5.6",
    });
    expect(verdict.status).toBe("unsupported");
    expect(verdict.evidence?.observedAt).toBe("2026-09-01");
    expect(verdict.evidence?.evidence).toMatch(/tools: \[\]/);
  });

  it.each([
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-sol",
    "openai/GPT-5.6-Terra",
  ])("codex at the pinned version refuses %s", (modelId) => {
    expect(
      harnessModelSupportAtPinnedVersion({ harnessId: "codex", modelId })
        .status,
    ).toBe("unsupported");
  });

  it("the gpt-5.6 rows do not swallow a longer numeric line (gpt-5.60)", () => {
    // `gpt-5.60` starts with the string "gpt-5.6" but is a different line: it
    // must fall through to the general gpt-5 row, not the tool-less one.
    for (const modelId of ["openai/gpt-5.60", "openai/gpt-5.61-mini"]) {
      const verdict = harnessModelSupport({
        harnessId: "codex",
        runtimeVersion: "0.149.1",
        modelId,
      });
      expect(verdict.status).toBe("supported");
      expect(verdict.evidence?.familyPattern).toBe("^openai/gpt-5");
    }
  });

  it("codex runs gpt-5.5", () => {
    for (const runtimeVersion of ["0.149.1", "0.160.0", undefined]) {
      expect(
        harnessModelSupport({
          harnessId: "codex",
          runtimeVersion,
          modelId: "openai/gpt-5.5",
        }).status,
      ).toBe("supported");
    }
  });

  it("claude-code runs claude-sonnet-4.5", () => {
    const verdict = harnessModelSupport({
      harnessId: "claude-code",
      runtimeVersion: PINNED_CLAUDE_CODE,
      modelId: "anthropic/claude-sonnet-4.5",
    });
    expect(verdict.status).toBe("supported");
    expect(verdict.evidence?.harness).toBe("claude-code");
  });

  it("cursor runs cursor/auto and nothing else", () => {
    expect(
      harnessModelSupport({
        harnessId: "cursor",
        runtimeVersion: null,
        modelId: "cursor/auto",
      }).status,
    ).toBe("supported");
    expect(
      harnessModelSupport({
        harnessId: "cursor",
        runtimeVersion: null,
        modelId: "anthropic/claude-sonnet-4.5",
      }).status,
    ).toBe("unsupported");
  });
});

describe("harnessModelSupport — semantics", () => {
  it("an unknown runtime version makes a version-specific row unknown", () => {
    for (const runtimeVersion of [undefined, null, "", "nightly"]) {
      const verdict = harnessModelSupport({
        harnessId: "codex",
        runtimeVersion,
        modelId: "openai/gpt-5.6-luna",
      });
      expect(verdict.status).toBe("unknown");
      expect(verdict.reason).toBe(
        runtimeVersion === "nightly"
          ? "not verified for codex nightly"
          : "not verified for codex (unknown version)",
      );
    }
  });

  it("an unknown runtime version does not affect `*` rows", () => {
    expect(
      harnessModelSupport({
        harnessId: "claude-code",
        modelId: "anthropic/claude-opus-4.7",
      }).status,
    ).toBe("supported");
    expect(
      harnessModelSupport({ harnessId: "codex", modelId: "openai/o1" }).status,
    ).toBe("unsupported");
  });

  it("a harness with no rows is unknown", () => {
    const verdict = harnessModelSupport({
      harnessId: "some-new-harness",
      runtimeVersion: "1.0.0",
      modelId: "openai/gpt-5.5",
    });
    expect(verdict).toEqual({
      status: "unknown",
      reason: "not verified for some-new-harness 1.0.0",
    });
  });

  it("first matching row wins", () => {
    const rows = [
      {
        harness: "h",
        versionRange: "*",
        familyPattern: "^a/",
        status: "unsupported" as const,
        evidence: "first",
        observedAt: "2026-01-01",
      },
      {
        harness: "h",
        versionRange: "*",
        familyPattern: "^a/b$",
        status: "supported" as const,
        evidence: "second",
        observedAt: "2026-01-01",
      },
    ];
    const verdict = harnessModelSupport({
      harnessId: "h",
      runtimeVersion: "1.0.0",
      modelId: "a/b",
      rows,
    });
    expect(verdict.status).toBe("unsupported");
    expect(verdict.evidence?.evidence).toBe("first");
  });

  it("normalizes bare, dashed and dated spellings before matching", () => {
    expect(normalizeHarnessModelId("claude-haiku-4-5-20251001")).toBe(
      "anthropic/claude-haiku-4.5",
    );
    expect(normalizeHarnessModelId("anthropic/claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(normalizeHarnessModelId("anthropic/claude-opus-4-20250929")).toBe(
      "anthropic/claude-opus-4",
    );
    expect(normalizeHarnessModelId(" GPT-5.5 ")).toBe("openai/gpt-5.5");
    expect(normalizeHarnessModelId("cursor/auto")).toBe("cursor/auto");
    expect(
      harnessModelSupport({
        harnessId: "claude-code",
        runtimeVersion: PINNED_CLAUDE_CODE,
        modelId: "claude-sonnet-4-5-20250929",
      }).status,
    ).toBe("supported");
    expect(
      harnessModelSupport({
        harnessId: "codex",
        runtimeVersion: PINNED_CODEX,
        modelId: "gpt-5-nano",
      }).status,
    ).toBe("supported");
  });

  it("admits unknown only for chat", () => {
    const unknown = { status: "unknown" as const };
    expect(harnessModelVerdictAdmits(unknown, "chat")).toBe(true);
    expect(harnessModelVerdictAdmits(unknown, "eval")).toBe(false);
    expect(harnessModelVerdictAdmits(unknown, "swarm")).toBe(false);
    expect(harnessModelVerdictAdmits({ status: "supported" }, "eval")).toBe(
      true,
    );
    expect(harnessModelVerdictAdmits({ status: "unsupported" }, "chat")).toBe(
      false,
    );
  });
});

describe("versions", () => {
  it("parses versions", () => {
    expect(parseHarnessVersion("0.149.1")).toEqual([0, 149, 1]);
    expect(parseHarnessVersion("v2.1")).toEqual([2, 1, 0]);
    expect(parseHarnessVersion("0.160.0-alpha.1")).toEqual([0, 160, 0]);
    expect(parseHarnessVersion("latest")).toBeUndefined();
    expect(parseHarnessVersion(undefined)).toBeUndefined();
  });

  it("compares major.minor and ignores patch", () => {
    expect(harnessVersionInRange("<=0.149.x", "0.149.0")).toBe(true);
    expect(harnessVersionInRange("<=0.149.x", "0.149.99")).toBe(true);
    expect(harnessVersionInRange("<=0.149.x", "0.148.3")).toBe(true);
    expect(harnessVersionInRange("<=0.149.x", "0.150.0")).toBe(false);
    expect(harnessVersionInRange("<=0.149.x", "1.0.0")).toBe(false);
    expect(harnessVersionInRange(">0.149.x", "0.149.9")).toBe(false);
    expect(harnessVersionInRange(">0.149.x", "0.150.0")).toBe(true);
    expect(harnessVersionInRange(">0.149.x", "1.2.0")).toBe(true);
    expect(harnessVersionInRange("*", undefined)).toBe(true);
    expect(harnessVersionInRange(">0.149.x", undefined)).toBe(false);
    expect(harnessVersionInRange("~0.149", "0.149.0")).toBe(false);
  });
});

describe("evidence table", () => {
  it("every row is well-formed", () => {
    expect(HARNESS_MODEL_SUPPORT_ROWS.length).toBeGreaterThan(0);
    for (const row of HARNESS_MODEL_SUPPORT_ROWS) {
      expect(HARNESS_IDS as readonly string[]).toContain(row.harness);
      expect(isValidHarnessVersionRange(row.versionRange)).toBe(true);
      expect(() => new RegExp(row.familyPattern)).not.toThrow();
      expect(["supported", "unsupported", "unknown"]).toContain(row.status);
      expect(row.evidence.length).toBeGreaterThan(0);
      expect(row.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("every harness has a catch-all row, so no model falls off the table", () => {
    for (const harness of HARNESS_IDS) {
      expect(
        HARNESS_MODEL_SUPPORT_ROWS.some(
          (row) =>
            row.harness === harness &&
            row.versionRange === "*" &&
            row.familyPattern === ".*",
        ),
      ).toBe(true);
    }
  });

  it("pins the JSON bytes the backend mirrors", () => {
    // The backend keeps a byte-for-byte copy and pins its hash; a change here
    // is a change there. Update both in the same pair of PRs.
    const here = dirname(fileURLToPath(import.meta.url));
    const bytes = readFileSync(
      join(here, "..", "harness-model-support-evidence.json"),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "41b4b5c1219d35ba8891280f22a6600273a60c202de52f66dd5eda47d82068ee",
    );
  });
});

describe("harnessOrgUpstream", () => {
  it("maps each brokered harness to its vendor and native profile", () => {
    expect(harnessOrgUpstream("claude-code")).toEqual({
      provider: "anthropic",
      profile: "anthropic-native",
    });
    expect(harnessOrgUpstream("codex")).toEqual({
      provider: "openai",
      profile: "openai-native",
    });
  });

  it("is null for a harness on the customer's own account, or an unknown id", () => {
    expect(harnessOrgUpstream("cursor")).toBeNull();
    expect(harnessOrgUpstream("toString")).toBeNull();
    expect(harnessOrgUpstream("not-a-harness")).toBeNull();
  });

  it("admits only the harness's own vendor", () => {
    expect(harnessRunsOnOrgProvider("claude-code", "anthropic")).toBe(true);
    expect(harnessRunsOnOrgProvider("claude-code", "openai")).toBe(false);
    expect(harnessRunsOnOrgProvider("codex", "openai")).toBe(true);
    expect(harnessRunsOnOrgProvider("cursor", "anthropic")).toBe(false);
    expect(harnessRunsOnOrgProvider("codex", undefined)).toBe(false);
  });
});

describe("harnessNoRunnableModelReason", () => {
  it("names the harness and the org key that would run it", () => {
    expect(harnessNoRunnableModelReason("codex")).toBe(
      "Codex runs MCPJam models or your organization's OpenAI key. Add one in Organization models.",
    );
    expect(harnessNoRunnableModelReason("cursor")).toBe(
      "Cursor CLI has no model it can run here.",
    );
  });

  it("under the organization's key policy, names only the org vendor", () => {
    expect(
      harnessNoRunnableModelReason("claude-code", { requireOrgKeys: true }),
    ).toBe(
      "This organization requires its own provider keys, so Claude Code runs only on an organization Anthropic provider.",
    );
    expect(
      harnessNoRunnableModelReason("cursor", { requireOrgKeys: true }),
    ).toBe("Cursor CLI has no model it can run here.");
  });
});

describe("harnessOrgProviderUnsupportedReason", () => {
  it("offers MCPJam models only while the key policy is off", () => {
    expect(harnessOrgProviderUnsupportedReason("codex")).toBe(
      "the Codex harness runs MCPJam-provided models or your organization's OpenAI key",
    );
    expect(
      harnessOrgProviderUnsupportedReason("codex", { requireOrgKeys: true }),
    ).toBe("the Codex harness runs only on your organization's OpenAI key");
  });
});
