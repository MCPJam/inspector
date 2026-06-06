import { describe, expect, test } from "vitest";
import type { EvalTraceWidgetSnapshot } from "../eval-trace";
import {
  evalTraceSnapshotToPayload,
  normalizeWidgetCsp,
  sanitizeWidgetForBackend,
  type SharedChatWidgetSnapshotPayload,
} from "../widget-snapshot";

function makeEvalSnap(
  overrides: Partial<EvalTraceWidgetSnapshot> = {},
): EvalTraceWidgetSnapshot {
  return {
    toolCallId: "call-1",
    toolName: "create_view",
    protocol: "mcp-apps",
    serverId: "excalidraw",
    toolMetadata: {},
    widgetHtmlBlobId: "html-blob-1",
    ...overrides,
  };
}

describe("normalizeWidgetCsp", () => {
  test("picks string-array fields and drops non-string entries", () => {
    expect(
      normalizeWidgetCsp({
        connectDomains: ["a.com", "b.com"],
        resourceDomains: ["good.com", 123 as unknown as string, null],
        unknownField: "ignored",
      }),
    ).toEqual({
      connectDomains: ["a.com", "b.com"],
      resourceDomains: ["good.com"],
    });
  });

  test("returns undefined for non-object input", () => {
    expect(normalizeWidgetCsp(null)).toBeUndefined();
    expect(normalizeWidgetCsp(undefined)).toBeUndefined();
    expect(normalizeWidgetCsp("string")).toBeUndefined();
    expect(normalizeWidgetCsp(42)).toBeUndefined();
  });

  test("returns undefined when no recognized fields survive normalization", () => {
    // Empty record, record with only non-string-array fields, or record
    // with empty arrays — all collapse to absent CSP. Callers depend on
    // absent vs `{}` being distinguishable (backend mutations treat them
    // differently in the widgetCsp validator path).
    expect(normalizeWidgetCsp({})).toBeUndefined();
    expect(normalizeWidgetCsp({ unrelated: "x" })).toBeUndefined();
    expect(normalizeWidgetCsp({ connectDomains: [] })).toBeUndefined();
  });
});

describe("sanitizeWidgetForBackend", () => {
  test("escapes $-prefixed keys inside widgetPermissions", () => {
    const payload: SharedChatWidgetSnapshotPayload = {
      toolCallId: "c",
      toolName: "t",
      serverId: "s",
      widgetHtmlBlobId: "b",
      uiType: "mcp-apps",
      widgetPermissions: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        properties: {
          clipboard: {
            $ref: "#/definitions/Capability",
          },
        },
      },
    };
    const out = sanitizeWidgetForBackend(payload);
    const perms = out.widgetPermissions as Record<string, any>;
    expect(perms.$schema).toBeUndefined();
    expect(perms.__convexReserved__schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(perms.properties.clipboard.$ref).toBeUndefined();
    expect(perms.properties.clipboard.__convexReserved__ref).toBe(
      "#/definitions/Capability",
    );
  });

  test("is a no-op for payloads with no reserved keys", () => {
    const payload: SharedChatWidgetSnapshotPayload = {
      toolCallId: "c",
      toolName: "t",
      serverId: "s",
      widgetHtmlBlobId: "b",
      uiType: "openai-apps",
      widgetCsp: { connectDomains: ["a.com"] },
      widgetPermissive: true,
      prefersBorder: false,
    };
    expect(sanitizeWidgetForBackend(payload)).toEqual(payload);
  });
});

describe("evalTraceSnapshotToPayload", () => {
  test("maps protocol → uiType and forwards friendly serverId verbatim", () => {
    const out = evalTraceSnapshotToPayload(
      makeEvalSnap({ protocol: "openai-apps", serverId: "my-server" }),
    );
    expect(out).not.toBeNull();
    expect(out!.uiType).toBe("openai-apps");
    expect(out!.serverId).toBe("my-server");
    // `protocol` is the source-side field name; the payload doesn't
    // carry it through under either name.
    expect((out as unknown as Record<string, unknown>).protocol).toBeUndefined();
  });

  test("returns null when widgetHtmlBlobId is missing", () => {
    expect(
      evalTraceSnapshotToPayload(
        makeEvalSnap({ widgetHtmlBlobId: undefined }),
      ),
    ).toBeNull();
  });

  test("normalizes widgetCsp via normalizeWidgetCsp", () => {
    const out = evalTraceSnapshotToPayload(
      makeEvalSnap({
        widgetCsp: {
          connectDomains: ["a.com"],
          resourceDomains: ["good.com", 99 as unknown as string],
          extra: "x",
        },
      }),
    );
    expect(out!.widgetCsp).toEqual({
      connectDomains: ["a.com"],
      resourceDomains: ["good.com"],
    });
  });

  test("forwards optional fields when set, omits when absent", () => {
    const withAll = evalTraceSnapshotToPayload(
      makeEvalSnap({
        resourceUri: "ui://x",
        widgetPermissions: { camera: true },
        widgetPermissive: true,
        prefersBorder: false,
      }),
    );
    expect(withAll).toMatchObject({
      resourceUri: "ui://x",
      widgetPermissions: { camera: true },
      widgetPermissive: true,
      prefersBorder: false,
    });

    const minimal = evalTraceSnapshotToPayload(makeEvalSnap());
    expect(minimal!.resourceUri).toBeUndefined();
    expect(minimal!.widgetPermissions).toBeUndefined();
    expect(minimal!.widgetPermissive).toBeUndefined();
    expect(minimal!.prefersBorder).toBeUndefined();
  });

  test("drops toolMetadata and widgetHtmlUrl (backend stores them elsewhere or not at all)", () => {
    const out = evalTraceSnapshotToPayload(
      makeEvalSnap({
        toolMetadata: { someKey: "value" },
        widgetHtmlUrl: "http://example.test/widget",
      }),
    );
    expect((out as unknown as Record<string, unknown>).toolMetadata)
      .toBeUndefined();
    expect((out as unknown as Record<string, unknown>).widgetHtmlUrl)
      .toBeUndefined();
  });
});
