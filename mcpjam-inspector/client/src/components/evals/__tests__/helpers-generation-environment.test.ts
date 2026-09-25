import { describe, expect, it } from "vitest";
import {
  environmentTargetLabel,
  environmentTargetServersLabel,
  generationEnvironmentChoices,
  generationEnvironmentId,
  generationEnvironmentTarget,
  getEffectiveSuiteServers,
  resolveGenerationEnvironmentRequest,
  suiteHasRunnableServers,
} from "../helpers";
import type { EvalSuiteEnvironmentTarget } from "../types";

function target(
  id: string,
  fields: Partial<EvalSuiteEnvironmentTarget> = {},
): EvalSuiteEnvironmentTarget {
  return {
    environmentId: id,
    hostName: "Claude",
    modelId: "opus",
    serverAttachmentId: "group-1",
    serverNames: ["billing"],
    pluginVersionCount: 0,
    ...fields,
  };
}

function suite(targets: EvalSuiteEnvironmentTarget[] | undefined) {
  return {
    environmentIds: (targets ?? [target("a")]).map((t) => t.environmentId),
    environmentTargets: targets,
    // Legacy fields an environment suite's runs never read.
    environment: { servers: ["legacy-server"] },
  };
}

describe("environment suite readers", () => {
  it("lists the environments' servers, not the legacy fields", () => {
    expect(
      getEffectiveSuiteServers(
        suite([
          target("a", { serverNames: ["billing"] }),
          target("b", { serverNames: ["billing", "search"] }),
        ]),
      ),
    ).toEqual(["billing", "search"]);
  });

  it("counts a plugin-only environment as runnable, and a group-less one as not", () => {
    expect(
      suiteHasRunnableServers(
        suite([target("a", { serverNames: [], pluginVersionCount: 1 })]),
      ),
    ).toBe(true);
    expect(
      suiteHasRunnableServers(
        suite([
          target("a", { serverNames: [], serverAttachmentId: undefined }),
        ]),
      ),
    ).toBe(false);
    // Archived environments do not run.
    expect(
      suiteHasRunnableServers(
        suite([target("a", { unavailable: "archived" })]),
      ),
    ).toBe(false);
  });

  it("leaves an environment suite the backend doesn't describe to the launch", () => {
    expect(suiteHasRunnableServers(suite(undefined))).toBe(true);
    expect(generationEnvironmentTarget(suite(undefined)).kind).toBe("none");
  });

  it("keeps a legacy suite on its legacy fields", () => {
    expect(
      suiteHasRunnableServers({ environment: { servers: ["billing"] } }),
    ).toBe(true);
    expect(generationEnvironmentTarget({}).kind).toBe("legacy");
  });
});

describe("generation target", () => {
  const mixed = suite([
    target("a", { serverAttachmentId: "group-1" }),
    target("b", {
      hostName: "Cursor",
      serverAttachmentId: "group-2",
      serverNames: ["search"],
    }),
  ]);

  it("needs no choice when every environment connects the same servers", () => {
    const uniform = suite([target("a"), target("b", { modelId: "sonnet" })]);
    expect(generationEnvironmentChoices(uniform)).toBeNull();
    expect(generationEnvironmentId(uniform)).toBe("a");
  });

  it("asks a mixed suite to choose and honours the saved pick", () => {
    expect(
      generationEnvironmentChoices(mixed)?.map((t) => t.environmentId),
    ).toEqual(["a", "b"]);
    expect(generationEnvironmentId(mixed)).toBeUndefined();
    expect(generationEnvironmentId(mixed, "b")).toBe("b");
    // A stale pick is ignored rather than trusted.
    expect(generationEnvironmentId(mixed, "gone")).toBeUndefined();
  });

  it("treats plugin pins as a different server set", () => {
    expect(
      generationEnvironmentChoices(
        suite([target("a"), target("b", { pluginVersionCount: 1 })]),
      ),
    ).not.toBeNull();
  });

  it("labels an environment by name, else client and model", () => {
    expect(environmentTargetLabel(target("a", { name: " Prod " }))).toBe(
      "Prod",
    );
    expect(environmentTargetLabel(target("a"))).toBe("Claude · opus");
    expect(
      environmentTargetServersLabel(
        target("a", {
          serverNames: ["billing", "search"],
          pluginVersionCount: 2,
        }),
      ),
    ).toBe("billing, search + 2 plugins");
  });
});

describe("resolveGenerationEnvironmentRequest", () => {
  const mixed = suite([
    target("a", { serverAttachmentId: "group-1" }),
    target("b", {
      hostName: "Cursor",
      serverAttachmentId: "group-2",
      serverNames: ["search"],
    }),
  ]);

  it("resolves an environment by id or by its shown name", () => {
    expect(resolveGenerationEnvironmentRequest(mixed, "b", undefined)).toEqual({
      environmentId: "b",
    });
    expect(
      resolveGenerationEnvironmentRequest(mixed, "cursor · OPUS", undefined),
    ).toEqual({ environmentId: "b" });
  });

  it("refuses a name two environments share, but still takes an id", () => {
    const twins = suite([
      target("a", { serverAttachmentId: "group-1" }),
      target("b", { serverAttachmentId: "group-2", serverNames: ["search"] }),
    ]);
    expect(
      resolveGenerationEnvironmentRequest(twins, "Claude · opus", undefined),
    ).toEqual({ error: expect.stringMatching(/Name one by ID: a, b/) });
    expect(resolveGenerationEnvironmentRequest(twins, "b", undefined)).toEqual({
      environmentId: "b",
    });
  });

  it("uses the saved pick when the request names none", () => {
    expect(resolveGenerationEnvironmentRequest(mixed, undefined, "a")).toEqual({
      environmentId: "a",
    });
  });

  it("refuses to guess for a mixed suite and lists the choices", () => {
    const result = resolveGenerationEnvironmentRequest(
      mixed,
      undefined,
      undefined,
    );
    expect(result).toEqual({
      error: expect.stringMatching(/Claude · opus, Cursor · opus/),
    });
  });

  it("refuses an unknown or server-less environment", () => {
    expect(
      resolveGenerationEnvironmentRequest(mixed, "nope", undefined),
    ).toEqual({ error: expect.stringMatching(/no environment "nope"/) });
    const withEmpty = suite([
      target("a"),
      target("b", { serverNames: [], serverAttachmentId: undefined }),
    ]);
    expect(
      resolveGenerationEnvironmentRequest(withEmpty, "b", undefined),
    ).toEqual({ error: expect.stringMatching(/has no servers/) });
  });

  it("refuses an environment for a legacy suite", () => {
    expect(resolveGenerationEnvironmentRequest({}, "a", undefined)).toEqual({
      error: expect.stringMatching(/does not run environments/),
    });
    expect(
      resolveGenerationEnvironmentRequest({}, undefined, undefined),
    ).toEqual({});
  });
});
