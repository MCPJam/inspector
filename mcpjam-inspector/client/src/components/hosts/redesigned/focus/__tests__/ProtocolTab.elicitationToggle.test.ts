import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import {
  applyJsonToDraft,
  elicitationCapabilityState,
  protocolToJson,
  withElicitation,
  withoutElicitation,
} from "../ProtocolTab";

const UI_EXTENSION = "io.modelcontextprotocol/ui";

function elicitationOf(caps: Record<string, unknown> | undefined) {
  return (caps as { elicitation?: unknown } | undefined)?.elicitation;
}

function extensionsOf(caps: Record<string, unknown> | undefined) {
  return (caps as { extensions?: Record<string, unknown> } | undefined)
    ?.extensions;
}

describe("ProtocolTab elicitation capability helpers", () => {
  it("round-trips off -> on -> off, restoring the original shape", () => {
    const base = emptyHostConfigInputV2();
    expect(elicitationCapabilityState(base.clientCapabilities)).toEqual({
      enabled: false,
      url: false,
    });

    const on = withElicitation(base, { url: false });
    expect(elicitationCapabilityState(on.clientCapabilities)).toEqual({
      enabled: true,
      url: false,
    });
    expect(elicitationOf(on.clientCapabilities)).toEqual({ form: {} });
    // Elicitation is a TOP-LEVEL key: the EMA/Apps `extensions` map rides
    // along untouched.
    expect(extensionsOf(on.clientCapabilities)?.[UI_EXTENSION]).toBeDefined();

    const off = withoutElicitation(on);
    expect(elicitationCapabilityState(off.clientCapabilities)).toEqual({
      enabled: false,
      url: false,
    });
    expect(off.clientCapabilities).toEqual(base.clientCapabilities);
  });

  it("writes { form: {}, url: {} } when URL mode is on", () => {
    const base = emptyHostConfigInputV2();
    const on = withElicitation(base, { url: true });
    expect(elicitationOf(on.clientCapabilities)).toEqual({
      form: {},
      url: {},
    });
    expect(elicitationCapabilityState(on.clientCapabilities)).toEqual({
      enabled: true,
      url: true,
    });
  });

  it("does not mutate the previous draft", () => {
    const base = emptyHostConfigInputV2({
      clientCapabilities: { elicitation: { form: {}, url: {} } },
    });
    const snapshot = JSON.parse(JSON.stringify(base.clientCapabilities));
    withElicitation(base, { url: false });
    withElicitation(base, { url: true });
    withoutElicitation(base);
    expect(base.clientCapabilities).toEqual(snapshot);
  });

  it("reads a bare {} catalog shape as enabled with URL mode off", () => {
    // claude-code / cursor / vscode ship `elicitation: {}`; goose / codex ship
    // `elicitation: { form: {} }`. Both must read as ON.
    const bare = emptyHostConfigInputV2({
      clientCapabilities: { elicitation: {} },
    });
    expect(elicitationCapabilityState(bare.clientCapabilities)).toEqual({
      enabled: true,
      url: false,
    });

    const formOnly = emptyHostConfigInputV2({
      clientCapabilities: { elicitation: { form: {} } },
    });
    expect(elicitationCapabilityState(formOnly.clientCapabilities)).toEqual({
      enabled: true,
      url: false,
    });
  });

  it("preserves form payloads and unknown sibling sub-keys when enabling URL mode", () => {
    const base = emptyHostConfigInputV2({
      clientCapabilities: {
        elicitation: {
          form: { maxFields: 12 },
          experimentalThing: { keep: true },
        },
      },
    });
    const on = withElicitation(base, { url: true });
    expect(elicitationOf(on.clientCapabilities)).toEqual({
      form: { maxFields: 12 },
      experimentalThing: { keep: true },
      url: {},
    });

    // Turning URL mode back off drops only `url`.
    const urlOff = withElicitation(on, { url: false });
    expect(elicitationOf(urlOff.clientCapabilities)).toEqual({
      form: { maxFields: 12 },
      experimentalThing: { keep: true },
    });
  });

  it("preserves a hand-edited url payload on re-toggle", () => {
    const base = emptyHostConfigInputV2({
      clientCapabilities: {
        elicitation: { form: {}, url: { allowedSchemes: ["https"] } },
      },
    });
    const on = withElicitation(base, { url: true });
    expect(elicitationOf(on.clientCapabilities)).toEqual({
      form: {},
      url: { allowedSchemes: ["https"] },
    });
  });

  it("deletes the key on disable, keeping clientCapabilities an object", () => {
    const base = emptyHostConfigInputV2({
      clientCapabilities: { elicitation: { form: {}, url: {} } },
    });
    const off = withoutElicitation(base);
    expect(off.clientCapabilities).toEqual({});
    expect(
      Object.prototype.hasOwnProperty.call(
        off.clientCapabilities,
        "elicitation"
      )
    ).toBe(false);
    // The canonicalizer throws on undefined clientCapabilities — {} is the floor.
    expect(off.clientCapabilities).not.toBeUndefined();
  });

  it("preserves sibling capabilities on disable", () => {
    const base = emptyHostConfigInputV2({
      clientCapabilities: {
        elicitation: { form: {} },
        roots: { listChanged: true },
        extensions: { [UI_EXTENSION]: { mimeTypes: ["text/html"] } },
      },
    });
    const off = withoutElicitation(base);
    expect(off.clientCapabilities).toEqual({
      roots: { listChanged: true },
      extensions: { [UI_EXTENSION]: { mimeTypes: ["text/html"] } },
    });
  });

  it("leaves mistral's inert extensions marker alone (no synthetic restore)", () => {
    // Unlike withoutEmaExtension, this helper never deletes `extensions`, so
    // there is nothing to restore — and it must not invent the marker either.
    const withMarker = emptyHostConfigInputV2({
      hostStyle: "mistral",
      clientCapabilities: { extensions: {}, elicitation: { form: {} } },
    });
    expect(withoutElicitation(withMarker).clientCapabilities).toEqual({
      extensions: {},
    });

    const noMarker = emptyHostConfigInputV2({
      hostStyle: "mistral",
      clientCapabilities: { elicitation: { form: {} } },
    });
    expect(withoutElicitation(noMarker).clientCapabilities).toEqual({});
  });

  it("guards non-object elicitation values instead of throwing", () => {
    const base = emptyHostConfigInputV2({
      clientCapabilities: { elicitation: "junk" },
    });
    expect(elicitationCapabilityState(base.clientCapabilities)).toEqual({
      enabled: false,
      url: false,
    });

    const on = withElicitation(base, { url: true });
    expect(elicitationOf(on.clientCapabilities)).toEqual({ form: {}, url: {} });

    expect(withoutElicitation(base).clientCapabilities).toEqual({});
  });

  it("normalizes a junk url value so the checkbox state reads back true", () => {
    const base = emptyHostConfigInputV2({
      clientCapabilities: { elicitation: { form: {}, url: "yes" } },
    });
    expect(elicitationCapabilityState(base.clientCapabilities).url).toBe(false);

    const on = withElicitation(base, { url: true });
    expect(elicitationOf(on.clientCapabilities)).toEqual({ form: {}, url: {} });
    expect(elicitationCapabilityState(on.clientCapabilities).url).toBe(true);
  });

  it("round-trips through the JSON editor serializer verbatim", () => {
    const base = emptyHostConfigInputV2();
    const on = withElicitation(base, { url: true });

    const doc = protocolToJson(on);
    expect(doc.capabilities).toEqual(on.clientCapabilities);

    const backThrough = applyJsonToDraft(JSON.parse(JSON.stringify(doc)), on);
    expect(backThrough).not.toBeNull();
    expect(backThrough?.clientCapabilities).toEqual(on.clientCapabilities);
    expect(elicitationCapabilityState(backThrough?.clientCapabilities)).toEqual(
      { enabled: true, url: true }
    );

    // ...and the off state stays off across the same trip.
    const off = withoutElicitation(on);
    const offBack = applyJsonToDraft(
      JSON.parse(JSON.stringify(protocolToJson(off))),
      off
    );
    expect(elicitationCapabilityState(offBack?.clientCapabilities)).toEqual({
      enabled: false,
      url: false,
    });
  });
});
