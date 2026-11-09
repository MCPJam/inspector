import { describe, expect, it } from "vitest";
import { preflightTargets, runPreflight } from "../suite-run-preflight";
import type { EvalSuite } from "../../evals/types";

// Claude Code and Codex run on the organization's own key for their vendor,
// so under the policy a harness client is a problem only when its model
// isn't an organization model on that vendor. Cursor runs on the
// organization's Cursor key, so it is one only while that key isn't ready.
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

  // The org's Cursor key is its own key for Cursor: the key alone decides a
  // Cursor client, whatever its model, as the backend's launch does.
  const withKey = (readiness: "ready" | "missing" | "invalid") => ({
    ...strict,
    harnessKeys: { cursor: readiness },
  });
  const cursorModels = [
    ["openai/gpt-5", { modelId: "openai/gpt-5", source: "hosted", fallback }],
    ["openai/gpt-5", org("openai/gpt-5", "conn_openai")],
    // Cursor Auto names no model: Cursor picks one on its own account.
    ["cursor/auto", undefined],
  ] as const;

  it("lets a Cursor client through on a ready org Cursor key, whatever its model", () => {
    for (const [modelId, selection] of cursorModels) {
      expect(
        problemsFor("cursor", modelId, selection, withKey("ready")),
      ).toBeUndefined();
    }
  });

  it.each(["missing", "invalid"] as const)(
    "asks for an org Cursor key when the key is %s, in the launch's words",
    (readiness) => {
      for (const [modelId, selection] of cursorModels) {
        expect(
          problemsFor("cursor", modelId, selection, withKey(readiness)),
        ).toEqual([
          "Ask an org admin to add a Cursor key in Organization → AI providers.",
        ]);
      }
    },
  );

  it("leaves a Cursor client to the launch until its key is read", () => {
    expect(problemsFor("cursor", "cursor/auto")).toBeUndefined();
  });

  it("keeps the Claude Code and Codex rules when a Cursor key is ready", () => {
    expect(
      problemsFor(
        "claude",
        "openai/gpt-5",
        org("openai/gpt-5", "conn_openai"),
        withKey("ready"),
      ),
    ).toEqual([
      "openai/gpt-5 can't run on Claude Code. This organization requires its own provider keys, so Claude Code runs only on an organization Anthropic provider.",
    ]);
    expect(
      problemsFor(
        "codex",
        "openai/gpt-5",
        org("openai/gpt-5", "conn_openai"),
        withKey("ready"),
      ),
    ).toBeUndefined();
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

  it("decides a Cursor client on its key while its selection is unknown", () => {
    const cursorProblems = (readiness: "ready" | "missing") =>
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
        orgConfig: withKey(readiness),
      }).orgKeyProblems;
    expect(cursorProblems("ready")).toBeUndefined();
    expect(cursorProblems("missing")).toEqual([
      "Ask an org admin to add a Cursor key in Organization → AI providers.",
    ]);
  });
});
