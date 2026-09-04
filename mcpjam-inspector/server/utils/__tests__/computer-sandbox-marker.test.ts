import { describe, expect, it } from "vitest";
import {
  planScenarioSandbox,
  readComputerSandboxMode,
  readScenarioEnvironment,
  shouldWarnSecretsUndelivered,
} from "../scenario-runtime-config.js";
import { isSandboxNoticeReason } from "@/shared/sandbox-notice";

/**
 * The `computerSandbox` marker has THREE states, and the third one — absence —
 * is what makes this feature deployable without a flag day. These tests pin
 * that absence and malformation both mean "the backend told us nothing usable",
 * i.e. keep today's personal-computer behaviour.
 */
describe("readComputerSandboxMode", () => {
  it("reads the two stated modes", () => {
    expect(
      readComputerSandboxMode({ computerSandbox: { mode: "ephemeral" } }),
    ).toBe("ephemeral");
    expect(
      readComputerSandboxMode({
        computerSandbox: { mode: "unavailable", reason: "no ready build" },
      }),
    ).toBe("unavailable");
  });

  it("returns null for an OLD BACKEND — never 'unavailable'", () => {
    // Absent must not be read as "no image": that would silently strip bash
    // from every scenario the moment a deploy skewed.
    expect(readComputerSandboxMode({ computer: { kind: "personal" } })).toBe(
      null,
    );
    expect(readComputerSandboxMode(undefined)).toBe(null);
    expect(readComputerSandboxMode(null)).toBe(null);
  });

  it("returns null for a malformed marker — never 'ephemeral'", () => {
    // Reading garbage as `ephemeral` would provision a paid box against a
    // policy nobody stated.
    expect(readComputerSandboxMode({ computerSandbox: { mode: "yes" } })).toBe(
      null,
    );
    expect(readComputerSandboxMode({ computerSandbox: "ephemeral" })).toBe(
      null,
    );
    expect(readComputerSandboxMode({ computerSandbox: {} })).toBe(null);
  });
});

/**
 * The plan is the ONLY thing standing between a scenario turn and a call that
 * spends money, so the matrix is pinned exhaustively. The load-bearing row is
 * `not_a_data_plane`: provisioning is bearer-authed and succeeds from any
 * inspector, but a server without the E2B credentials can never exec in the
 * box — the old code stranded a billable sandbox whose every command failed.
 */
describe("planScenarioSandbox", () => {
  const ephemeral = {
    mode: "ephemeral" as const,
    bashRequested: true,
    ephemeralCloudAvailable: true,
    hasChatSessionId: true,
  };

  it("provisions only when every requirement holds", () => {
    expect(planScenarioSandbox(ephemeral)).toEqual({ action: "provision" });
  });

  it("suppresses WITH a tester notice when this server is not a data plane", () => {
    expect(
      planScenarioSandbox({ ...ephemeral, ephemeralCloudAvailable: false }),
    ).toEqual({
      action: "suppress",
      suppressReason: "not_a_data_plane",
      notice: "sandbox_unavailable",
    });
  });

  it("checks the data plane before the session id — the tester deserves the explanation either way", () => {
    expect(
      planScenarioSandbox({
        ...ephemeral,
        ephemeralCloudAvailable: false,
        hasChatSessionId: false,
      }),
    ).toMatchObject({ suppressReason: "not_a_data_plane" });
  });

  it("suppresses WITH a notice when the turn could not establish its secret state", () => {
    // A scenario conversation's box is keyed to the conversation and reused
    // across turns. A harness session in the same situation forks to a fresh
    // bridge holding nothing; this one cannot, so an earlier turn's credential
    // may still be sitting in a file or a background process while this turn
    // has no list to scrub what a command prints.
    expect(
      planScenarioSandbox({
        ...ephemeral,
        secretsUnavailable: true,
        environmentSelectsSecrets: true,
      }),
    ).toEqual({
      action: "suppress",
      suppressReason: "secrets_unavailable",
      notice: "secrets_unavailable",
    });
  });

  it("does NOT suppress a conversation whose environment has no secrets", () => {
    // The half that keeps this from repeating the 503 mistake. `{ok:false}`
    // covers every failure of the secrets service, so keying on it alone would
    // take bash away from every scenario conversation during a blip —
    // including the overwhelming majority that never had a secret and whose box
    // holds nothing to leak.
    expect(
      planScenarioSandbox({
        ...ephemeral,
        secretsUnavailable: true,
        environmentSelectsSecrets: false,
      }),
    ).toEqual({ action: "provision" });
    // Absent (an older backend) is treated the same way, so a deploy skew
    // cannot start suppressing shells.
    expect(
      planScenarioSandbox({ ...ephemeral, secretsUnavailable: true }),
    ).toEqual({ action: "provision" });
  });

  it("does NOT suppress when secrets simply resolved to none", () => {
    // The distinction the tri-state exists for. An environment that grants
    // nothing is an ordinary turn; only a FAILED resolution leaves the box's
    // contents unknown.
    expect(
      planScenarioSandbox({
        ...ephemeral,
        secretsUnavailable: false,
        environmentSelectsSecrets: true,
      }),
    ).toEqual({ action: "provision" });
    expect(planScenarioSandbox(ephemeral)).toEqual({ action: "provision" });
  });

  it("does not narrate at a turn that never asked for bash", () => {
    // Ordering: the bash-requested exit comes first, so a conversation with no
    // shell in play gets no notice about one.
    expect(
      planScenarioSandbox({
        ...ephemeral,
        bashRequested: false,
        secretsUnavailable: true,
        environmentSelectsSecrets: true,
      }),
    ).toEqual({ action: "none" });
  });

  it("suppresses silently (log-only) without a chatSessionId", () => {
    expect(
      planScenarioSandbox({ ...ephemeral, hasChatSessionId: false }),
    ).toEqual({ action: "suppress", suppressReason: "no_chat_session_id" });
  });

  it("suppresses on an `unavailable` marker regardless of anything else", () => {
    expect(
      planScenarioSandbox({
        ...ephemeral,
        mode: "unavailable",
        ephemeralCloudAvailable: false,
        bashRequested: false,
      }),
    ).toEqual({
      action: "suppress",
      suppressReason: "sandbox_mode_unavailable",
    });
  });

  it("does nothing for a legacy (marker-absent) config — even on a non-data-plane server", () => {
    // Absent marker = personal-computer behavior; the preflight must not
    // start stripping bash from legacy scenarios on deploy skew.
    expect(
      planScenarioSandbox({
        ...ephemeral,
        mode: null,
        ephemeralCloudAvailable: false,
      }),
    ).toEqual({ action: "none" });
  });

  it("does nothing when the turn never asked for bash — no notice noise", () => {
    expect(
      planScenarioSandbox({
        ...ephemeral,
        bashRequested: false,
        ephemeralCloudAvailable: false,
      }),
    ).toEqual({ action: "none" });
  });
});

/**
 * MATERIALIZED secrets resolved with nowhere legitimate to put them.
 *
 * The drop itself is correct and must stay: `resolveHostTools` reads
 * `secretEnv` only inside its `sandboxBinding` branch, because a materialized
 * value becomes a real environment variable in whatever box runs the command,
 * and a project's credential belongs only in a box the project provisioned. A
 * direct (non-scenario) environment chat's bash runs on the member's own
 * machine or a shared remote runner.
 *
 * What these pin is that the drop is NARRATED. Silence is what turned a
 * deliberate refusal into a tester debugging a 401 against a credential they
 * can see selected in the environment editor.
 */
describe("shouldWarnSecretsUndelivered", () => {
  const base = {
    secretCount: 2,
    hasSandboxBinding: false,
    harness: null as string | null,
  };

  it("warns for a direct environment chat — the case that went silent", () => {
    expect(shouldWarnSecretsUndelivered(base)).toBe(true);
  });

  it("stays quiet when a project-provisioned box will receive them", () => {
    // The scenario path: the secrets are delivered, so a notice would be a lie.
    expect(
      shouldWarnSecretsUndelivered({ ...base, hasSandboxBinding: true }),
    ).toBe(false);
  });

  it("stays quiet on a harness turn, which delivers them another way", () => {
    // `run-harness-turn` fetches its own secrets and hands them over as
    // `sessionEnv`, with no `sandboxBinding` involved. Keying the warning on
    // the binding alone would fire on EVERY harness turn — the loudest possible
    // false alarm, on the path where delivery actually works.
    expect(
      shouldWarnSecretsUndelivered({ ...base, harness: "claude-code" }),
    ).toBe(false);
    expect(
      shouldWarnSecretsUndelivered({
        ...base,
        harness: "claude-code",
        hasSandboxBinding: true,
      }),
    ).toBe(false);
  });

  it("stays quiet when there was nothing to deliver", () => {
    // The overwhelmingly common turn: no materialized secrets at all. A notice
    // here would tell every user their secrets went missing when they have
    // none, and brokered-only environments are exactly this case — brokered
    // values are injected outside the box and never enter `secretEnv`.
    expect(shouldWarnSecretsUndelivered({ ...base, secretCount: 0 })).toBe(
      false,
    );
    expect(shouldWarnSecretsUndelivered({ ...base, secretCount: -1 })).toBe(
      false,
    );
  });
});

/**
 * The wiring between the backend's flag and the decision that reads it.
 *
 * These exist because the suppression shipped INERT once: `planScenarioSandbox`
 * was unit-tested by handing it `environmentSelectsSecrets` directly, which
 * proved the decision and nothing about whether the value ever arrives.
 * `readScenarioEnvironment` builds its result field by field rather than
 * spreading the raw payload, so the new flag was silently dropped and read as
 * `undefined` — indistinguishable from "this environment has no secrets", the
 * safe-looking half of the answer. Nothing failed; the guard just never fired.
 */
describe("selectsMaterializedSecrets survives the parser", () => {
  // The parser reads `config.environment`, so the fixture is a whole runtime
  // config rather than the environment alone.
  const rawEnvironment = (extra: Record<string, unknown>) =>
    ({
      environment: {
        environmentRef: { environmentId: "env-1", name: "prod", revision: 3 },
        servers: { effectiveServerIds: ["srv-1"] },
        ...extra,
      },
    } as never);

  it("carries `true` through to the parsed environment", () => {
    const parsed = readScenarioEnvironment(
      rawEnvironment({ selectsMaterializedSecrets: true }),
    );
    expect(parsed.kind).toBe("present");
    if (parsed.kind !== "present") return;
    expect(parsed.environment.selectsMaterializedSecrets).toBe(true);
  });

  it("carries `false` through as false, not as absent", () => {
    const parsed = readScenarioEnvironment(
      rawEnvironment({ selectsMaterializedSecrets: false }),
    );
    if (parsed.kind !== "present") throw new Error("expected present");
    expect(parsed.environment.selectsMaterializedSecrets).toBe(false);
  });

  it("omits it for an older backend rather than inventing a value", () => {
    const parsed = readScenarioEnvironment(rawEnvironment({}));
    if (parsed.kind !== "present") throw new Error("expected present");
    expect(parsed.environment.selectsMaterializedSecrets).toBeUndefined();
    // Absent must read as "do not suppress" — a deploy skew cannot start
    // taking shells away.
    expect(
      planScenarioSandbox({
        mode: "ephemeral",
        bashRequested: true,
        ephemeralCloudAvailable: true,
        hasChatSessionId: true,
        secretsUnavailable: true,
        environmentSelectsSecrets:
          parsed.environment.selectsMaterializedSecrets === true,
      }),
    ).toEqual({ action: "provision" });
  });

  it("end to end: a parsed flag actually reaches the suppression", () => {
    // The assertion the original unit test could not make, because it fed the
    // flag straight in.
    const parsed = readScenarioEnvironment(
      rawEnvironment({ selectsMaterializedSecrets: true }),
    );
    if (parsed.kind !== "present") throw new Error("expected present");
    expect(
      planScenarioSandbox({
        mode: "ephemeral",
        bashRequested: true,
        ephemeralCloudAvailable: true,
        hasChatSessionId: true,
        secretsUnavailable: true,
        environmentSelectsSecrets:
          parsed.environment.selectsMaterializedSecrets === true,
      }),
    ).toEqual({
      action: "suppress",
      suppressReason: "secrets_unavailable",
      notice: "secrets_unavailable",
    });
  });

  it("ignores a non-boolean rather than coercing it", () => {
    const parsed = readScenarioEnvironment(
      rawEnvironment({ selectsMaterializedSecrets: "yes" }),
    );
    if (parsed.kind !== "present") throw new Error("expected present");
    expect(parsed.environment.selectsMaterializedSecrets).toBeUndefined();
  });

  it("the notice the plan mints is one the client will accept", () => {
    // The second half of the same inert-shipping bug: `isSandboxNoticeReason`
    // is an allowlist, and a reason missing from it is dropped on the wire —
    // so a notice can be minted correctly and still never reach the user.
    expect(isSandboxNoticeReason("secrets_unavailable")).toBe(true);
    expect(isSandboxNoticeReason("secrets_undelivered")).toBe(true);
    expect(isSandboxNoticeReason("not_a_real_reason")).toBe(false);
  });
});
