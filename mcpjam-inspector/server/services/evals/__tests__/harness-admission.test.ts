import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkEvalExecutionAdmission,
  checkEvalHarnessAdmission,
  checkEvalHarnessStaticAdmission,
  executionEngineLabel,
  harnessOfHostConfig,
  hasSelectedMcpServersForAdmission,
  resolveEvalCaseModelDefinition,
} from "../harness-admission";
import { harnessModelEligibleForRuntime } from "../../../utils/harness/harness-availability";
import { getHarnessAdapter } from "../../../utils/harness/registry";

/**
 * The gate that stops a harness-hosted eval run from silently executing on the
 * emulated engine and reporting green. See `harness-admission.ts` for why the
 * shared `checkHarnessRuntimeAvailable` is CALLED rather than re-derived.
 */

const ENV_KEYS = [
  "CONVEX_HTTP_URL",
  "INSPECTOR_SERVICE_TOKEN",
  "COMPUTERS_TERMINAL_TOKEN_SECRET",
  "E2B_API_KEY",
  "MCPJAM_HARNESS_BROKER_DELIVERY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  // A server on which the harness runtime IS available, so every refusal below
  // is attributable to the configuration under test rather than the fixture.
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
  process.env.INSPECTOR_SERVICE_TOKEN = "test-svc-token";
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "terminal-secret-16+";
  process.env.E2B_API_KEY = "e2b-test";
  // Explicit rather than inherited: the shared gate reads this key and treats
  // an unset value as enabled, so leaving it ambient would make every verdict
  // below depend on the machine the suite happens to run on.
  process.env.MCPJAM_HARNESS_BROKER_DELIVERY = "true";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const HOSTED_MODEL = {
  model: "anthropic/claude-haiku-4.5",
  provider: "anthropic",
};
const BYOK_MODEL = { model: "some-local-model", provider: "ollama" };

function harnessHost(extra: Record<string, unknown> = {}) {
  return { harness: "claude-code", ...extra };
}

describe("checkEvalHarnessAdmission", () => {
  it("admits a non-harness host untouched — the overwhelmingly common case", () => {
    expect(
      checkEvalHarnessAdmission({
        hostConfig: { hostStyle: "mcpjam" },
        serverIds: ["s1"],
        cases: [{ title: "a", ...HOSTED_MODEL }],
      })
    ).toEqual({ ok: true });

    // Null host config (a suite that never wrote one) is emulated, not harness.
    expect(checkEvalHarnessAdmission({ hostConfig: null, cases: [] })).toEqual({
      ok: true,
    });
  });

  it("ADMITS a harness host with no pinned computer — it boots the default image", () => {
    // Requiring a pinned image left harness evals with no working road on a
    // deployment whose image builder is the inert `stub`: the only permitted
    // road was a custom image, and every image such a deployment can build
    // boots a template the model broker then refuses to lease against. An
    // unpinned run boots the deployment-default template instead — still a
    // fresh disposable box per iteration, still never the personal computer.
    expect(
      checkEvalHarnessAdmission({
        hostConfig: harnessHost(),
        serverIds: ["s1"],
        cases: [{ title: "a", ...HOSTED_MODEL }],
      })
    ).toEqual({ ok: true, harness: "claude-code" });
  });

  it("REFUSES cases asserting something a harness run cannot observe", () => {
    // A harness reaches MCP through the signed proxy, so the inspector's
    // widget manager never sees the call. Skipping the assertion instead would
    // make a passing run indistinguishable from one where it actually held.
    const verdict = checkEvalHarnessAdmission({
      hostConfig: harnessHost(),
      serverIds: ["s1"],
      cases: [{ title: "a", ...HOSTED_MODEL }],
      widgetAssertingCaseTitles: ["renders the card"],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("widgetRendered");
    expect(verdict.reason).toContain("renders the card");
  });

  it("names the INELIGIBLE CASES when a suite mixes hosted and BYOK models", () => {
    const verdict = checkEvalHarnessAdmission({
      hostConfig: harnessHost(),
      serverIds: ["s1"],
      cases: [
        { title: "hosted case", ...HOSTED_MODEL },
        { title: "byok case", ...BYOK_MODEL },
      ],
      // A pinned computer clears the last admission rule, so an ineligible
      // model must still fail — it routes through the direct engine, which
      // never forwards a harness.
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("only runs MCPJam-provided models");
    expect(verdict.reason).toContain("byok case");
    expect(verdict.reason).not.toContain("hosted case");
  });

  // Codex, not Claude Code: Claude Code can pause on every surface now, so an
  // approval host is admissible there. Codex cannot pause at all, which is the
  // host-level refusal this test is about.
  it("reports a HOST-level refusal once, not per case", () => {
    const verdict = checkEvalHarnessAdmission({
      hostConfig: { harness: "codex", requireToolApproval: true },
      serverIds: ["s1"],
      cases: [
        { title: "one", ...HOSTED_MODEL },
        { title: "two", ...HOSTED_MODEL },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("approval");
    expect(verdict.reason).not.toContain("Ineligible cases");
  });

  it("does not gate MODEL-FREE cases on model eligibility", () => {
    // The recorder emits `widget-probe`/`none` sentinels for pinned-only cases.
    // They never reach a model runtime, so refusing the suite over them would
    // reject a configuration it does not actually use.
    const verdict = checkEvalHarnessAdmission({
      hostConfig: harnessHost(),
      serverIds: ["s1"],
      cases: [{ title: "probe", model: "widget-probe", provider: "none" }],
    });
    expect(verdict).toEqual({ ok: true, harness: "claude-code" });
  });

  it("admits an eligible harness host", () => {
    expect(
      checkEvalHarnessAdmission({
        hostConfig: harnessHost(),
        serverIds: ["s1"],
        cases: [{ title: "a", ...HOSTED_MODEL }],
      })
    ).toEqual({ ok: true, harness: "claude-code" });
  });

  it("refuses when broker delivery is switched off, with the gate's own reason", () => {
    process.env.MCPJAM_HARNESS_BROKER_DELIVERY = "false";
    const verdict = checkEvalHarnessAdmission({
      hostConfig: harnessHost(),
      serverIds: ["s1"],
      cases: [{ title: "a", ...HOSTED_MODEL }],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("broker");
  });

  it("admits Codex for a suite with MCP servers (host-executed delivery)", () => {
    // COMP-39 inverts this case. An eval suite ALWAYS has servers, so the old
    // "Codex cannot deliver MCP servers" refusal meant Codex could never run
    // ANY eval suite. It now delivers them as host-executed tools, so a Codex
    // suite is admissible on the same terms as a Claude Code one.
    expect(
      checkEvalHarnessAdmission({
        hostConfig: { harness: "codex" },
        serverIds: ["s1"],
        cases: [{ title: "a", model: "openai/gpt-5", provider: "openai" }],
      })
    ).toEqual({ ok: true, harness: "codex" });
  });
});

describe("checkEvalHarnessStaticAdmission", () => {
  it("never consults a pinned image — the batch dry run has none to give", () => {
    // The group route validates targets before any environment resolution, so
    // it could only ever pass "not looked up". Now nothing asks: a harness run
    // boots a box with or without a pinned image, so the fan-out's dry run has
    // one less fact to hold and one less way to refuse a target wrongly.
    expect(
      checkEvalHarnessStaticAdmission({
        hostConfig: harnessHost(),
        serverIds: ["s1"],
      })
    ).toEqual({ ok: true, harness: "claude-code" });
  });

  it("decides host-level rules with no cases at all — what batch dry-run needs", () => {
    expect(
      checkEvalHarnessStaticAdmission({
        hostConfig: { hostStyle: "mcpjam" },
        serverIds: ["s1"],
      })
    ).toEqual({ ok: true });

    // Codex: it cannot pause for approval on any surface. (An approval host on
    // Claude Code is admitted now — asserted below.)
    const approvalHost = checkEvalHarnessStaticAdmission({
      hostConfig: { harness: "codex", requireToolApproval: true },
      serverIds: ["s1"],
    });
    expect(approvalHost.ok).toBe(false);
  });

  it("does NOT refuse on model eligibility when the host pins no model", () => {
    // With no host-pinned model the probe id is empty, which is not evidence
    // about any model the caller configured. The full check owns that call.
    const verdict = checkEvalHarnessStaticAdmission({
      hostConfig: harnessHost(),
      serverIds: ["s1"],
    });
    expect(verdict).toEqual({ ok: true, harness: "claude-code" });
  });

  it("refuses a host-pinned model the harness cannot run", () => {
    const verdict = checkEvalHarnessStaticAdmission({
      hostConfig: harnessHost({ modelId: "ollama/llama3" }),
      serverIds: ["s1"],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("MCPJam-provided models");
  });

  // The rule is asserted DIRECTLY rather than through a refusal, because no
  // registered harness currently produces one on this arm: the gate reads
  // `supportsMcpToolApproval` for native delivery (Claude Code — now true) and
  // `supportsHostExecutedToolApproval` for host-executed (Codex — which never
  // reaches that arm, since it fails the native-approval check first). Asserting
  // it through whichever harness happened to refuse is what made this coverage
  // disappear the moment a capability flipped.
  it("counts PLUGIN-contributed servers toward the MCP-tool approval gate", () => {
    // A host whose servers come solely from a plugin must still read as
    // "has servers" — otherwise it slips the gate entirely.
    expect(
      hasSelectedMcpServersForAdmission({
        serverIds: [],
        pluginServerIds: ["plugin-server-1"],
      })
    ).toBe(true);
    expect(
      hasSelectedMcpServersForAdmission({ serverIds: ["s1"] })
    ).toBe(true);
    expect(
      hasSelectedMcpServersForAdmission({ serverIds: [], pluginServerIds: [] })
    ).toBe(false);
    expect(hasSelectedMcpServersForAdmission({})).toBe(false);
  });

  // The end-to-end half that IS still observable: a plugin-only host reaches
  // the gate and is admitted on a harness that can approve MCP tools. If
  // plugin servers were dropped on the way in, this would pass for the wrong
  // reason — so it is a companion to the direct assertion above, not a
  // replacement for it.
  it("admits a plugin-only approval host on a harness that can approve MCP tools", () => {
    expect(
      checkEvalHarnessStaticAdmission({
        hostConfig: harnessHost({ requireToolApproval: true }),
        serverIds: [],
        pluginServerIds: ["plugin-server-1"],
      })
    ).toEqual({ ok: true, harness: "claude-code" });
  });

  it("an approval host with NO servers at all is not caught by that gate", () => {
    // The control for the case above: without the plugin servers the same host
    // passes, so the refusal really did come from counting them.
    expect(
      checkEvalHarnessStaticAdmission({
        hostConfig: { harness: "claude-code", requireToolApproval: true },
        serverIds: [],
      })
    ).toEqual({ ok: true, harness: "claude-code" });
  });
});

describe("attribution helpers", () => {
  it("reads only a REGISTERED harness id off a host config", () => {
    expect(harnessOfHostConfig({ harness: "claude-code" })).toBe("claude-code");
    expect(harnessOfHostConfig({ harness: "not-a-harness" })).toBeUndefined();
    expect(harnessOfHostConfig(null)).toBeUndefined();
  });

  it("labels the engine the run executes on", () => {
    expect(executionEngineLabel({ harness: "claude-code" })).toBe(
      "harness:claude-code"
    );
    expect(executionEngineLabel({ hostStyle: "mcpjam" })).toBe("emulated");
    expect(executionEngineLabel(null)).toBe("emulated");
  });
});

describe("checkEvalHarnessAdmission — org-level suites", () => {
  // `runHarnessTurn` needs a projectId to resolve the box and throws without
  // one — MID-ITERATION, after the sandbox has been booted and charged. This
  // turns that into a pre-flight refusal that spends nothing.
  const args = {
    hostConfig: harnessHost(),
    serverIds: ["srv-1"],
    cases: [HOSTED_MODEL],
  };

  it("refuses a harness run with no resolved project", () => {
    const verdict = checkEvalHarnessAdmission({ ...args, projectId: null });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("organization");
  });

  it("names the missing PROJECT — the one thing that still cannot be defaulted", () => {
    // An image can be defaulted; a project cannot. There is nothing to bill or
    // provision against, so this stays a refusal — and it must not send the
    // author to a computer-image setting that cannot fix it.
    const verdict = checkEvalHarnessAdmission({
      ...args,
      projectId: null,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("organization");
    expect(verdict.reason).not.toContain("pin a computer image");
  });

  it("admits a harness run that HAS a project", () => {
    expect(checkEvalHarnessAdmission({ ...args, projectId: "proj-1" }).ok).toBe(
      true
    );
  });

  it("does not refuse a harness run whose caller resolved no project field", () => {
    // `undefined` is "not looked up" and must not be read as absence — the
    // static half has no project to resolve.
    expect(checkEvalHarnessAdmission(args).ok).toBe(true);
  });
});

describe("checkEvalHarnessAdmission — the pinned model must be canonical", () => {
  // The backend pins the case's model string VERBATIM and the broker's eval
  // authorizer matches it byte-exact against what the runtime asks for — and
  // the runtime canonicalizes first. A short form therefore passes every other
  // check, boots a paid box, and dies at broker start on an opaque 403.
  const args = {
    hostConfig: harnessHost(),
    serverIds: ["srv-1"],
    projectId: "proj-1",
  };
  // Same model as HOSTED_MODEL, written the short way — which is what the
  // public case-create API accepts and stores today.
  const SHORT = { model: "claude-haiku-4.5", provider: "anthropic" };

  it("refuses a case pinning a short model id, naming both spellings", () => {
    const verdict = checkEvalHarnessAdmission({
      ...args,
      cases: [{ title: "a", ...SHORT }],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain('"claude-haiku-4.5"');
    expect(verdict.reason).toContain('"anthropic/claude-haiku-4.5"');
  });

  it("admits the same model written canonically", () => {
    expect(
      checkEvalHarnessAdmission({
        ...args,
        cases: [{ title: "a", ...HOSTED_MODEL }],
      }).ok
    ).toBe(true);
  });

  it("reports an INELIGIBLE model first when a suite has both problems", () => {
    // Ordering, not just refusal: a BYOK model cannot run the harness at ALL,
    // so telling the author to re-spell a different case's id would send them
    // to fix the smaller thing and hit the wall again.
    const verdict = checkEvalHarnessAdmission({
      ...args,
      cases: [
        { title: "byok", ...BYOK_MODEL },
        { title: "short", ...SHORT },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("byok");
    expect(verdict.reason).not.toContain("Save the case with the full id");
  });

  it("does not fire for an EMULATED host — no lease is ever requested", () => {
    expect(
      checkEvalHarnessAdmission({
        hostConfig: { hostStyle: "mcpjam" },
        cases: [{ title: "a", ...SHORT }],
      }).ok
    ).toBe(true);
  });

  it("ignores model-free cases, whose sentinel is not a model", () => {
    expect(
      checkEvalHarnessAdmission({
        ...args,
        cases: [
          { title: "probe", model: "widget-probe", provider: "none" },
          { title: "a", ...HOSTED_MODEL },
        ],
      }).ok
    ).toBe(true);
  });
});

describe("checkEvalExecutionAdmission", () => {
  // Runs for EVERY eval, harness or emulated. It cannot live in the harness
  // checks above, which return admitted on their first line when no harness is
  // selected — which is exactly the runs this rule is about.

  it("refuses a bash-granting host when the environment pins no image", () => {
    // `resolveHostTools` warn-and-SKIPS bash here, so the run would execute
    // with the shell silently absent: cases needing one fail as if the model
    // chose badly, and a suite that did not need one reports green for a host
    // configuration that never existed.
    const verdict = checkEvalExecutionAdmission({
      hostConfig: { hostStyle: "mcpjam", builtInToolIds: ["bash"] },
      pinnedComputerImageId: null,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("bash");
    expect(verdict.reason).toContain("computer image");
  });

  it("refuses on an EMULATED host — the harness gates never see this case", () => {
    const emulated = { hostStyle: "mcpjam", builtInToolIds: ["bash"] };
    expect(
      checkEvalHarnessAdmission({
        hostConfig: emulated,
        cases: [HOSTED_MODEL],
      }).ok
    ).toBe(true);
    expect(
      checkEvalExecutionAdmission({
        hostConfig: emulated,
        pinnedComputerImageId: null,
      }).ok
    ).toBe(false);
  });

  it("admits the same host once an image is pinned", () => {
    expect(
      checkEvalExecutionAdmission({
        hostConfig: { builtInToolIds: ["bash"] },
        pinnedComputerImageId: "env-1",
      }).ok
    ).toBe(true);
  });

  it("admits non-computer built-ins with no image — they need no box", () => {
    expect(
      checkEvalExecutionAdmission({
        hostConfig: { builtInToolIds: ["web_search"] },
        pinnedComputerImageId: null,
      }).ok
    ).toBe(true);
  });

  it("admits a host that grants no built-ins at all", () => {
    for (const hostConfig of [
      null,
      {},
      { builtInToolIds: [] },
      { builtInToolIds: "bash" },
    ]) {
      expect(
        checkEvalExecutionAdmission({
          hostConfig: hostConfig as Record<string, unknown> | null,
          pinnedComputerImageId: null,
        }).ok
      ).toBe(true);
    }
  });

  // ── The single-case surface ──────────────────────────────────────────────
  // Quick and streamed one-offs pass `runId: null`, and BOTH sandbox-
  // provisioning sites require `runId !== null` — so no box is ever booted for
  // them and a pinned image changes nothing. The rule is the surface itself.

  it("refuses a computer-backed built-in on a single-case run, image or not", () => {
    for (const pinnedComputerImageId of [null, "env-1"]) {
      const verdict = checkEvalExecutionAdmission({
        hostConfig: { builtInToolIds: ["bash"] },
        pinnedComputerImageId,
        surface: "single-case",
      });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      // The advice must NOT be "pin an image" — pinning one would not help.
      expect(verdict.reason).toContain("never provisions a computer");
      expect(verdict.reason).toContain("as part of a suite");
      expect(verdict.reason).not.toContain("Pin one on the environment");
    }
  });

  it("still admits a single-case run with no computer-backed built-in", () => {
    expect(
      checkEvalExecutionAdmission({
        hostConfig: { builtInToolIds: ["web_search"] },
        surface: "single-case",
      }).ok
    ).toBe(true);
  });

  it("REFUSES a harness on the single-case surface, whatever tools it grants", () => {
    // The gap this closes: a single-case run boots no box, so `runHarnessTurn`
    // would fall through to `resolveHarnessSandbox` — the acting member's
    // PERSONAL computer. That is the one fallback eval execution must never
    // take, and it was reachable here because this surface never ran the
    // harness gate at all.
    for (const hostConfig of [
      { harness: "claude-code" },
      { harness: "claude-code", builtInToolIds: [] },
      { harness: "claude-code", builtInToolIds: ["bash"] },
    ]) {
      const verdict = checkEvalExecutionAdmission({
        hostConfig,
        pinnedComputerImageId: "env-1",
        surface: "single-case",
      });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      expect(verdict.reason).toContain("as part of a suite");
      expect(verdict.reason).toContain("personal computer");
    }
  });

  it("ADMITS a bash-granting HARNESS host with no image — it boots its own box", () => {
    // The rule's premise ("there will be no computer") is false for a harness
    // run: it provisions a disposable box whether or not an image is pinned.
    // Refusing here would re-impose the pinned-image requirement through the
    // back door, for exactly the hosts most likely to want a shell.
    expect(
      checkEvalExecutionAdmission({
        hostConfig: { harness: "claude-code", builtInToolIds: ["bash"] },
        pinnedComputerImageId: null,
      }).ok
    ).toBe(true);
  });

  it("keeps refusing an EMULATED bash host with no image", () => {
    // The exemption above is scoped to harness runs only — an emulated run
    // still boots nothing, so the silent-missing-shell failure it prevents is
    // still live for the much larger emulated population.
    expect(
      checkEvalExecutionAdmission({
        hostConfig: { harness: "not-a-harness", builtInToolIds: ["bash"] },
        pinnedComputerImageId: null,
      }).ok
    ).toBe(false);
  });

  it("leaves the suite surface unchanged — an image still admits it", () => {
    // The default surface must keep its old behavior exactly; only the
    // single-case one ignores the pin.
    expect(
      checkEvalExecutionAdmission({
        hostConfig: { builtInToolIds: ["bash"] },
        pinnedComputerImageId: "env-1",
      }).ok
    ).toBe(true);
    expect(
      checkEvalExecutionAdmission({
        hostConfig: { builtInToolIds: ["bash"] },
        pinnedComputerImageId: "env-1",
        surface: "run",
      }).ok
    ).toBe(true);
  });

  it("names every offending id, deduped", () => {
    const verdict = checkEvalExecutionAdmission({
      hostConfig: { builtInToolIds: ["bash", "web_search", "bash"] },
      pinnedComputerImageId: null,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("bash");
    expect(verdict.reason).not.toContain("web_search");
    expect(verdict.reason.match(/bash/g)).toHaveLength(2); // named twice in one sentence pair
  });
});

/**
 * ADMISSION AND EXECUTION HAVE TO AGREE, and on an external-account host they
 * did not: admission reads the HOST's id (a per-case model cannot answer
 * "does this host carry the runtime's sentinel?"), then execution carried the
 * CASE's model to the dispatch, whose eligibility check saw a non-sentinel on
 * an external-account harness and refused a run it had already admitted.
 *
 * A per-case model is normal and legitimate in evals — a suite names one per
 * case and is then pointed at a host — so that refusal hit ordinary Cursor
 * suites. The seam is closed by making the host's model authoritative in eval
 * execution too, the way it already is on the chat rails.
 */
describe("external-account hosts: the host's model is what an eval case runs", () => {
  const cursorHost = { harness: "cursor", modelId: "cursor/auto" };
  const caseModel = {
    id: "anthropic/claude-haiku-4.5",
    name: "Haiku",
    provider: "anthropic" as const,
  };

  it("promotes the host's sentinel over the case's own model", () => {
    const resolved = resolveEvalCaseModelDefinition({
      hostConfig: cursorHost,
      caseModel,
    });

    expect(resolved.id).toBe("cursor/auto");
    // Carries the curated label and the registered provider, not a re-derived
    // guess — the same definition the swarm runner builds for a pinned target.
    expect(resolved.name).toBe("Cursor Auto");
    expect(resolved.provider).toBe("cursor");
  });

  it("admits that case AND leaves it dispatchable — the two ends now agree", () => {
    // The end this test exists for. Admission accepting while the dispatch
    // refuses is the disagreement; asserting only the first half is what let it
    // through.
    expect(
      checkEvalHarnessAdmission({
        hostConfig: cursorHost,
        serverIds: ["s1"],
        cases: [
          {
            title: "a",
            model: caseModel.id,
            provider: caseModel.provider,
          },
        ],
      })
    ).toEqual({ ok: true, harness: "cursor" });

    const resolved = resolveEvalCaseModelDefinition({
      hostConfig: cursorHost,
      caseModel,
    });
    expect(
      harnessModelEligibleForRuntime({
        adapter: getHarnessAdapter("cursor"),
        modelId: String(resolved.id),
        provider: resolved.provider,
      })
    ).toBe(true);
  });

  it("leaves a BROKERED harness host's case model alone", () => {
    // The promotion is keyed on `modelAccess`, not on "the host runs a CLI". A
    // Claude Code suite's per-case model is the model that actually runs.
    expect(
      resolveEvalCaseModelDefinition({
        hostConfig: { harness: "claude-code", modelId: "openai/gpt-5-mini" },
        caseModel,
      }).id
    ).toBe(caseModel.id);
  });

  it("leaves a non-harness host's case model alone", () => {
    expect(
      resolveEvalCaseModelDefinition({
        hostConfig: { hostStyle: "mcpjam", modelId: "openai/gpt-5-mini" },
        caseModel,
      }).id
    ).toBe(caseModel.id);
    expect(
      resolveEvalCaseModelDefinition({ hostConfig: null, caseModel }).id
    ).toBe(caseModel.id);
  });

  it("does NOT promote a mis-configured external-account host's ordinary id", () => {
    // Promoting it would launder a broken configuration into the run record.
    // Admission refuses this host on its own id instead.
    const misconfigured = {
      harness: "cursor",
      modelId: "anthropic/claude-sonnet-4.5",
    };
    expect(
      resolveEvalCaseModelDefinition({ hostConfig: misconfigured, caseModel })
        .id
    ).toBe(caseModel.id);

    const verdict = checkEvalHarnessAdmission({
      hostConfig: misconfigured,
      serverIds: ["s1"],
      cases: [{ title: "a", model: caseModel.id, provider: caseModel.provider }],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("anthropic/claude-sonnet-4.5");
    }
  });
});
