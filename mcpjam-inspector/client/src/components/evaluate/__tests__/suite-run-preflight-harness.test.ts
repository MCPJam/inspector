import { describe, expect, it } from "vitest";
import { preflightTargets, runPreflight } from "../suite-run-preflight";
import type { EvalSuite } from "../../evals/types";

// Claude Code and Codex run on the organization's own key for their vendor,
// so under the policy a harness client is a problem only when its model
// isn't an organization model on that vendor. Cursor runs on no organization
// connection, so it is always one.
describe("a harness client under the policy", () => {
  const fallback = { provider: "none", model: "none" } as const;
  const strict = {
    providers: [
      {
        id: "conn_anthropic",
        providerKey: "anthropic",
        enabled: true,
        hasSecret: true,
        policyEligibility: { eligible: true },
      },
      {
        id: "conn_openai",
        providerKey: "openai",
        enabled: true,
        hasSecret: true,
        policyEligibility: { eligible: true },
      },
    ],
    aiKeyPolicy: { requireOrgKeys: true, revision: 1 },
  };
  const org = (modelId: string, connection: string) => ({
    modelId,
    source: "org",
    connectionRef: { kind: "orgProvider", id: connection },
    fallback,
  });
  const hosts = [
    { hostId: "claude", harness: "claude-code" },
    { hostId: "codex", harness: "codex" },
    { hostId: "cursor", harness: "cursor" },
    { hostId: "emulated" },
  ];
  const suite = {
    _id: "suite",
    name: "S",
    environmentIds: ["env"],
  } as unknown as EvalSuite;
  const problemsFor = (
    hostId: string,
    modelId: string,
    modelSelection?: unknown,
    orgConfig: Parameters<typeof runPreflight>[0]["orgConfig"] = strict,
  ) =>
    runPreflight({
      ...preflightTargets({
        suite,
        cases: [],
        environments: [],
        hosts,
        environmentServerRefs: [],
        targets: [
          {
            hostId,
            modelId,
            ...(modelSelection
              ? { modelSelection: modelSelection as never }
              : {}),
          },
        ],
      }),
      servers: {},
      orgConfig,
    }).orgKeyProblems;

  it("lets an organization model on the harness's own vendor through", () => {
    expect(
      problemsFor(
        "claude",
        "anthropic/claude-sonnet-4.5",
        org("anthropic/claude-sonnet-4.5", "conn_anthropic"),
      ),
    ).toBeUndefined();
    expect(
      problemsFor("codex", "openai/gpt-5", org("openai/gpt-5", "conn_openai")),
    ).toBeUndefined();
  });

  it("names the vendor the harness needs for another vendor's organization model", () => {
    expect(
      problemsFor("claude", "openai/gpt-5", org("openai/gpt-5", "conn_openai")),
    ).toEqual([
      "openai/gpt-5 can't run on Claude Code. This organization requires its own provider keys, so Claude Code runs only on an organization Anthropic provider.",
    ]);
  });

  it("says the same for an MCPJam-provided model, instead of the generic line", () => {
    const problems = problemsFor("codex", "openai/gpt-5", {
      modelId: "openai/gpt-5",
      source: "hosted",
      fallback,
    });
    expect(problems).toEqual([
      "openai/gpt-5 can't run on Codex. This organization requires its own provider keys, so Codex runs only on an organization OpenAI provider.",
    ]);
  });

  it("leaves an emulated client to the model check", () => {
    expect(
      problemsFor("emulated", "openai/gpt-5", {
        modelId: "openai/gpt-5",
        source: "hosted",
        fallback,
      })?.join("\n"),
    ).toMatch(/openai\/gpt-5 is an MCPJam-provided model/);
  });

  it("names a legacy model's missing connection on its matching-vendor harness", () => {
    const problems = problemsFor("codex", "openai/gpt-5", {
      modelId: "openai/gpt-5",
      source: "legacy",
    });
    expect(problems?.[0]).toMatch(
      /isn't saved with an organization provider connection/,
    );
    expect(problems?.[0]).not.toMatch(/can't run on Codex/);
  });

  it("refuses a Cursor client whatever its model, as the backend does", () => {
    // The backend refuses every Cursor runtime (`org_runtime_unsupported`).
    const cursor = [
      "Cursor CLI can't run on an organization's providers, so it is unavailable while the organization requires its own keys. Choose another client for this run.",
    ];
    expect(
      problemsFor("cursor", "openai/gpt-5", {
        modelId: "openai/gpt-5",
        source: "hosted",
        fallback,
      }),
    ).toEqual(cursor);
    expect(
      problemsFor("cursor", "openai/gpt-5", org("openai/gpt-5", "conn_openai")),
    ).toEqual(cursor);
    // Cursor Auto names no model: Cursor picks one on its own account.
    expect(problemsFor("cursor", "cursor/auto")).toEqual(cursor);
  });

  it("raises nothing with the policy off", () => {
    expect(
      problemsFor(
        "claude",
        "openai/gpt-5",
        { modelId: "openai/gpt-5", source: "hosted", fallback },
        { providers: strict.providers },
      ),
    ).toBeUndefined();
    expect(
      problemsFor("cursor", "cursor/auto", undefined, {
        providers: strict.providers,
      }),
    ).toBeUndefined();
  });

  it.each(["codex", "claude-code"])(
    "defers the %s vendor check until an inherited selection resolves",
    (harness) => {
      const targets = preflightTargets({
        suite,
        cases: [],
        environments: [],
        hosts: [
          {
            hostId: "client",
            modelId: "openai/gpt-5",
            harness,
            selectionKnown: false,
          },
        ],
        environmentServerRefs: [],
        targets: [{ hostId: "client" }],
      });
      expect(
        runPreflight({ ...targets, servers: {}, orgConfig: strict })
          .orgKeyProblems,
      ).toBeUndefined();
    },
  );

  it("still refuses a runtime with no organization-key path while its selection is unknown", () => {
    expect(
      runPreflight({
        serverRefs: [],
        servers: {},
        models: [
          {
            model: "openai/gpt-5",
            provider: "openai",
            harness: "cursor",
            selectionKnown: false,
          },
        ],
        orgConfig: strict,
      }).orgKeyProblems?.[0],
    ).toMatch(/Cursor CLI can't run/);
  });
});
