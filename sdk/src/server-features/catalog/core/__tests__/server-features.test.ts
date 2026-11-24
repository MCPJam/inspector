import { describe, expect, it } from "vitest";
import {
  fullCoverage,
  makeProbe,
  makeSurface,
} from "../../../__tests__/fixtures.js";
import { CORE_FEATURES } from "../index.js";
import { declared, isGap, kindOf, probed } from "./helpers.js";

describe("resources", () => {
  const surface = makeSurface({
    capabilities: { resources: { listChanged: true } },
    resources: [
      { uri: "https://example.com/a", name: "a" },
      { uri: "file:///b.txt", name: "b" },
      { uri: "FILE:///c.txt", name: "c" },
    ],
  });

  it("reads the capability, the list and the URI schemes", () => {
    expect(kindOf(declared("resources.capability", surface))).toBe("present");
    expect(declared("resources.list", surface)).toMatchObject({
      kind: "present",
      count: 3,
    });
    expect(declared("resources.uri-schemes", surface)).toMatchObject({
      kind: "present",
      detail: "file, https",
    });
    expect(kindOf(declared("resources.list-changed", surface))).toBe("unknown");
  });

  it("never reads a partial resource list as a gap", () => {
    const partial = makeSurface({
      coverage: fullCoverage({ resources: "partial" }),
    });
    expect(isGap(declared("resources.list", partial), partial)).toBe(false);
    expect(isGap(declared("resources.uri-schemes", partial), partial)).toBe(
      false
    );
    const complete = makeSurface();
    expect(isGap(declared("resources.list", complete), complete)).toBe(true);
    expect(kindOf(declared("resources.uri-schemes", complete))).toBe(
      "not-applicable"
    );
  });

  it("shows resources/read from a background read of a UI or skill resource", () => {
    const ui = {
      "apps-ui-resources": makeProbe("apps-ui-resources", { readCount: 2 }),
    };
    expect(probed("resources.read", ui)).toMatchObject({
      kind: "present",
      count: 2,
    });
    const skills = {
      "apps-ui-resources": makeProbe("apps-ui-resources", { readCount: 0 }),
      skills: makeProbe("skills", { verified: 1 }),
    };
    expect(kindOf(probed("resources.read", skills))).toBe("present");
    expect(probed("resources.read", {})).toBeNull();
  });
});

describe("resource templates", () => {
  it("lists templates and counts described ones", () => {
    const surface = makeSurface({
      capabilities: { resources: {} },
      resourceTemplates: [
        { uriTemplate: "file:///{path}", name: "file", description: "A file." },
        { uriTemplate: "db://{table}", name: "table" },
      ],
    });
    expect(declared("resource-templates.list", surface)).toMatchObject({
      count: 2,
    });
    expect(declared("resource-templates.fields", surface)).toMatchObject({
      kind: "present",
      count: 1,
    });
  });

  it("is a gap only when both the capability and the list were captured", () => {
    const complete = makeSurface();
    expect(isGap(declared("resource-templates.list", complete), complete)).toBe(
      true
    );
    const partial = makeSurface({
      coverage: fullCoverage({ resourceTemplates: "not-captured" }),
    });
    expect(isGap(declared("resource-templates.list", partial), partial)).toBe(
      false
    );
  });

  it("offers templates to a server that has resources but no templates", () => {
    const resourcesOnly = makeSurface({
      capabilities: { resources: {} },
      resources: [{ uri: "file:///a.txt", name: "a" }],
    });
    expect(declared("resource-templates.list", resourcesOnly)).toMatchObject({
      kind: "absent",
      basis: ["resourceTemplates"],
    });
    expect(
      isGap(declared("resource-templates.list", resourcesOnly), resourcesOnly)
    ).toBe(true);
  });
});

describe("prompts", () => {
  it("reads the capability, the list and arguments", () => {
    const surface = makeSurface({
      capabilities: { prompts: { listChanged: false } },
      prompts: [
        { name: "summarize", arguments: [{ name: "text", required: true }] },
        { name: "hello" },
      ],
    });
    expect(kindOf(declared("prompts.capability", surface))).toBe("present");
    expect(declared("prompts.arguments", surface)).toMatchObject({ count: 1 });
    expect(isGap(declared("prompts.list-changed", surface), surface)).toBe(
      true
    );
  });

  it("does not call missing arguments a gap on a partial list", () => {
    const partial = makeSurface({
      prompts: [{ name: "hello" }],
      coverage: fullCoverage({ prompts: "partial" }),
    });
    expect(isGap(declared("prompts.arguments", partial), partial)).toBe(false);
  });
});

describe("completion, pagination and caching", () => {
  it("reads the completions capability", () => {
    const surface = makeSurface({ capabilities: { completions: {} } });
    expect(kindOf(declared("completion.capability", surface))).toBe("present");
    const partial = makeSurface({
      coverage: fullCoverage({ capabilities: "partial" }),
    });
    expect(isGap(declared("completion.capability", partial), partial)).toBe(
      false
    );
  });

  it("shows pagination only when a list used more than one page", () => {
    const paged = makeSurface({ listHints: { tools: { pages: 3 } } });
    expect(declared("pagination.cursor", paged)).toMatchObject({
      kind: "present",
      detail: "Paged tools/list.",
    });
    const onePage = makeSurface({ listHints: { tools: { pages: 1 } } });
    expect(kindOf(declared("pagination.cursor", onePage))).toBe("unknown");
    const notCaptured = makeSurface({
      coverage: fullCoverage({ listHints: "partial" }),
    });
    expect(declared("pagination.cursor", notCaptured)).toBeNull();
  });

  it("accepts ttlMs 0 and rejects an unknown cacheScope", () => {
    const surface = makeSurface({
      protocolVersion: "2026-07-28",
      listHints: { tools: { ttlMs: 0, cacheScope: "shared" } },
    });
    expect(kindOf(declared("caching.ttl-ms", surface))).toBe("present");
    expect(isGap(declared("caching.cache-scope", surface), surface)).toBe(true);
    const partial = makeSurface({
      coverage: fullCoverage({ listHints: "partial" }),
    });
    expect(isGap(declared("caching.ttl-ms", partial), partial)).toBe(false);
  });
});

describe("request control, client features, MRTR and subscriptions", () => {
  it("reads the logging capability", () => {
    const surface = makeSurface({ capabilities: { logging: {} } });
    expect(kindOf(declared("request-control.logging", surface))).toBe(
      "present"
    );
    expect(
      isGap(declared("request-control.logging", makeSurface()), makeSurface())
    ).toBe(true);
  });

  it("assesses runtime-only families from traffic, never from the declaration", () => {
    const runtime = CORE_FEATURES.filter((entry) =>
      ["client-features", "mrtr"].includes(entry.family)
    );
    expect(runtime.length).toBe(18);
    for (const entry of runtime) {
      expect(entry.assessment.declared, entry.id).toBeUndefined();
    }
    const seenInUse = CORE_FEATURES.filter(
      (entry) => entry.family === "client-features" && !entry.parent
    ).concat(
      CORE_FEATURES.filter((entry) => entry.parent === "client.elicitation")
    );
    for (const entry of seenInUse) {
      if (entry.id === "client.elicitation") continue;
      expect(entry.assessment.observable, entry.id).toBe(true);
    }
  });

  it("waits for an update before trusting resources.subscribe", () => {
    const promised = makeSurface({
      capabilities: { resources: { subscribe: true } },
    });
    expect(
      kindOf(declared("subscriptions.resources-subscribe", promised))
    ).toBe("unknown");
    const explicitFalse = makeSurface({
      capabilities: { resources: { subscribe: false } },
    });
    expect(
      isGap(
        declared("subscriptions.resources-subscribe", explicitFalse),
        explicitFalse
      )
    ).toBe(true);
    expect(
      kindOf(declared("subscriptions.resources-subscribe", makeSurface()))
    ).toBe("not-applicable");
  });
});
