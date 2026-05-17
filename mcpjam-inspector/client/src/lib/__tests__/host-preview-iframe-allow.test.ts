import { describe, expect, it } from "vitest";
import { previewIframeAllow } from "../host-preview-iframe-allow";
import type { HostConfigMcpProfileV1 } from "../host-config-v2";

const profile = (
  permissions: HostConfigMcpProfileV1["apps"] extends infer A
    ? A extends { sandbox?: { permissions?: infer P } }
      ? P
      : never
    : never,
): HostConfigMcpProfileV1 => ({
  profileVersion: 1,
  apps: { sandbox: { permissions } },
});

describe("previewIframeAllow", () => {
  // Default posture: when the host hasn't opted in via apps.sandbox.permissions,
  // emit the full SEP-1865 spec set on the wrapper so the inner mcp-apps
  // renderer (the authoritative per-resource gate) isn't pre-blocked. Mirrors
  // the chatbox-surface CSP default of "permissive".
  const FULL_SPEC = "camera; microphone; geolocation; clipboard-write";

  it("emits full spec set when profile is undefined (permissive chatbox default)", () => {
    expect(previewIframeAllow(undefined)).toBe(FULL_SPEC);
  });

  it("emits full spec set when permissions block is omitted", () => {
    expect(previewIframeAllow({ profileVersion: 1 })).toBe(FULL_SPEC);
    expect(previewIframeAllow({ profileVersion: 1, apps: {} })).toBe(FULL_SPEC);
    expect(previewIframeAllow({ profileVersion: 1, apps: { sandbox: {} } })).toBe(
      FULL_SPEC,
    );
  });

  it("returns empty string for deny-all regardless of allow map", () => {
    expect(
      previewIframeAllow(
        profile({ mode: "deny-all", allow: { clipboardWrite: true, camera: true } }),
      ),
    ).toBe("");
  });

  it("emits only host-allowed spec features in custom mode", () => {
    expect(
      previewIframeAllow(
        profile({ mode: "custom", allow: { clipboardWrite: true } }),
      ),
    ).toBe("clipboard-write");

    expect(
      previewIframeAllow(
        profile({
          mode: "custom",
          allow: { clipboardWrite: true, camera: true, microphone: true },
        }),
      ),
    ).toBe("camera; microphone; clipboard-write");
  });

  it("ignores unknown / unspec'd keys (allowlist enforcement)", () => {
    expect(
      previewIframeAllow(
        profile({
          mode: "custom",
          allow: {
            clipboardWrite: true,
            // Not in SEP-1865; must be dropped.
            usbDevices: true as unknown as boolean,
            "*": true as unknown as boolean,
          },
        }),
      ),
    ).toBe("clipboard-write");
  });

  it("ignores allow entries set to false", () => {
    expect(
      previewIframeAllow(
        profile({
          mode: "custom",
          allow: { clipboardWrite: true, camera: false },
        }),
      ),
    ).toBe("clipboard-write");
  });

  it("emits the full spec set in resource-declared mode", () => {
    expect(previewIframeAllow(profile({ mode: "resource-declared" }))).toBe(
      "camera; microphone; geolocation; clipboard-write",
    );
  });

  // Deny entries are camelCase profile keys (matching the editor + allow map),
  // not the kebab-case Permissions-Policy feature tokens that end up in the
  // iframe `allow=` attribute.
  it("honors deny in resource-declared mode (deny wins over implicit allow)", () => {
    expect(
      previewIframeAllow(
        profile({
          mode: "resource-declared",
          deny: ["microphone", "camera"],
        }),
      ),
    ).toBe("geolocation; clipboard-write");
  });

  it("honors clipboardWrite deny in resource-declared mode (camelCase key, not feature token)", () => {
    expect(
      previewIframeAllow(
        profile({
          mode: "resource-declared",
          deny: ["clipboardWrite"],
        }),
      ),
    ).toBe("camera; microphone; geolocation");
  });

  it("honors deny in custom mode (deny wins over explicit allow)", () => {
    expect(
      previewIframeAllow(
        profile({
          mode: "custom",
          allow: { clipboardWrite: true, microphone: true },
          deny: ["microphone"],
        }),
      ),
    ).toBe("clipboard-write");
  });

  it("honors clipboardWrite deny in custom mode (camelCase key, not feature token)", () => {
    expect(
      previewIframeAllow(
        profile({
          mode: "custom",
          allow: { clipboardWrite: true, microphone: true },
          deny: ["clipboardWrite"],
        }),
      ),
    ).toBe("microphone");
  });
});
