import { describe, expect, it } from "vitest";
import {
  fullCoverage,
  makeProbe,
  makeSurface,
} from "../../../__tests__/fixtures.js";
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
