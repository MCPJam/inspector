import { describe, expect, it } from "vitest";
import {
  emptyHostConfigInputV2,
  hostConfigDtoToInput,
  hostConfigInputsEqual,
  type HostConfigDtoV2,
  type HostConfigInputV2,
} from "../host-config-v2";

function makeInput(overrides: Partial<HostConfigInputV2> = {}): HostConfigInputV2 {
  return emptyHostConfigInputV2({
    hostStyle: "claude",
    modelId: "claude-sonnet-4-5",
    systemPrompt: "you are helpful",
    temperature: 0.5,
    requireToolApproval: false,
    serverIds: [],
    optionalServerIds: [],
    connectionDefaults: { headers: { "X-A": "1" }, requestTimeout: 10000 },
    clientCapabilities: {},
    hostContext: {},
    ...overrides,
  });
}

describe("hostConfigInputsEqual", () => {
  it("returns true for identical inputs", () => {
    expect(hostConfigInputsEqual(makeInput(), makeInput())).toBe(true);
  });

  it("returns false when modelId differs", () => {
    expect(
      hostConfigInputsEqual(
        makeInput({ modelId: "a" }),
        makeInput({ modelId: "b" }),
      ),
    ).toBe(false);
  });

  it("ignores serverIds order", () => {
    const a = makeInput({ serverIds: ["s1", "s2", "s3"] });
    const b = makeInput({ serverIds: ["s3", "s1", "s2"] });
    expect(hostConfigInputsEqual(a, b)).toBe(true);
  });

  it("ignores nested object key order in clientCapabilities", () => {
    const a = makeInput({
      clientCapabilities: { caps: { a: 1, b: 2 } } as Record<string, unknown>,
    });
    const b = makeInput({
      clientCapabilities: { caps: { b: 2, a: 1 } } as Record<string, unknown>,
    });
    expect(hostConfigInputsEqual(a, b)).toBe(true);
  });

  it("ignores nested object key order in hostContext", () => {
    const a = makeInput({
      hostContext: { ctx: { x: "1", y: "2" } } as Record<string, unknown>,
    });
    const b = makeInput({
      hostContext: { ctx: { y: "2", x: "1" } } as Record<string, unknown>,
    });
    expect(hostConfigInputsEqual(a, b)).toBe(true);
  });

  it("detects nested value changes", () => {
    const a = makeInput({
      clientCapabilities: { caps: { a: 1 } } as Record<string, unknown>,
    });
    const b = makeInput({
      clientCapabilities: { caps: { a: 2 } } as Record<string, unknown>,
    });
    expect(hostConfigInputsEqual(a, b)).toBe(false);
  });

  it("treats optionalServerIds order-insensitively", () => {
    const a = makeInput({ optionalServerIds: ["x", "y"] });
    const b = makeInput({ optionalServerIds: ["y", "x"] });
    expect(hostConfigInputsEqual(a, b)).toBe(true);
  });

  it("returns false when connectionDefaults.requestTimeout differs", () => {
    const a = makeInput({
      connectionDefaults: { headers: {}, requestTimeout: 5000 },
    });
    const b = makeInput({
      connectionDefaults: { headers: {}, requestTimeout: 5001 },
    });
    expect(hostConfigInputsEqual(a, b)).toBe(false);
  });
});

describe("emptyHostConfigInputV2", () => {
  it("clones every caller-provided array/record (no aliasing)", () => {
    const seedServerIds = ["a", "b"];
    const seedHeaders = { Foo: "bar" };
    const seedCaps = { x: 1 } as Record<string, unknown>;
    const seedCtx = { y: 2 } as Record<string, unknown>;

    const result = emptyHostConfigInputV2({
      serverIds: seedServerIds,
      optionalServerIds: ["a"],
      connectionDefaults: { headers: seedHeaders, requestTimeout: 1234 },
      clientCapabilities: seedCaps,
      hostContext: seedCtx,
    });

    // mutate the result; seeds must not change.
    result.serverIds.push("c");
    result.optionalServerIds.push("c");
    result.connectionDefaults.headers["Other"] = "v";
    (result.clientCapabilities as Record<string, unknown>).z = 99;
    (result.hostContext as Record<string, unknown>).w = 99;

    expect(seedServerIds).toEqual(["a", "b"]);
    expect(seedHeaders).toEqual({ Foo: "bar" });
    expect(seedCaps).toEqual({ x: 1 });
    expect(seedCtx).toEqual({ y: 2 });
  });
});

describe("hostConfigDtoToInput", () => {
  it("clones every array/record so the dto cannot be mutated through the input", () => {
    const dto: HostConfigDtoV2 = {
      id: "host-1",
      schemaVersion: 2,
      hostStyle: "claude",
      modelId: "x",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: ["s1"],
      optionalServerIds: ["o1"],
      connectionDefaults: { headers: { K: "V" }, requestTimeout: 10000 },
      clientCapabilities: { c: 1 } as Record<string, unknown>,
      hostContext: { h: 2 } as Record<string, unknown>,
    };
    const input = hostConfigDtoToInput(dto);

    input.serverIds.push("mutated");
    input.optionalServerIds.push("mutated");
    input.connectionDefaults.headers["Mutated"] = "yes";
    (input.clientCapabilities as Record<string, unknown>).new = 1;
    (input.hostContext as Record<string, unknown>).new = 1;

    expect(dto.serverIds).toEqual(["s1"]);
    expect(dto.optionalServerIds).toEqual(["o1"]);
    expect(dto.connectionDefaults.headers).toEqual({ K: "V" });
    expect(dto.clientCapabilities).toEqual({ c: 1 });
    expect(dto.hostContext).toEqual({ h: 2 });
  });

  it("deep-clones nested clientCapabilities and hostContext", () => {
    const dto: HostConfigDtoV2 = {
      id: "host-2",
      schemaVersion: 2,
      hostStyle: "claude",
      modelId: "x",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
      clientCapabilities: {
        extensions: { mimeTypes: ["a", "b"] },
      } as Record<string, unknown>,
      hostContext: {
        nested: { deep: { value: 1 } },
      } as Record<string, unknown>,
    };
    const input = hostConfigDtoToInput(dto);

    // Mutate inside the nested trees and confirm the source DTO is
    // unaffected — proves the clone descends into nested structures.
    (
      (input.clientCapabilities.extensions as Record<string, unknown>)
        .mimeTypes as string[]
    ).push("c");
    (
      (
        (input.hostContext.nested as Record<string, unknown>).deep as Record<
          string,
          unknown
        >
      ) as { value: number }
    ).value = 999;

    expect(
      (dto.clientCapabilities.extensions as Record<string, unknown>).mimeTypes,
    ).toEqual(["a", "b"]);
    expect(
      (
        (dto.hostContext.nested as Record<string, unknown>).deep as Record<
          string,
          unknown
        >
      ),
    ).toEqual({ value: 1 });
  });
});
