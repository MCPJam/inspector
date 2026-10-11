import { describe, expect, it } from "vitest";
import { preflightTargets, runPreflight } from "../suite-run-preflight";
import type { EvalSuite } from "../../evals/types";

// Claude Code and Codex run on the organization's own key for their vendor,
// so under the policy a harness client is a problem only when its model
// isn't an organization model on that vendor.
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

  it("leaves an emulated client and a harness on its own account to the model check", () => {
    for (const hostId of ["emulated", "cursor"]) {
      expect(
        problemsFor(hostId, "openai/gpt-5", {
          modelId: "openai/gpt-5",
          source: "hosted",
          fallback,
        })?.join("\n"),
      ).toMatch(/openai\/gpt-5 is an MCPJam-provided model/);
    }
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
  });
});
