import { describe, it, expect } from "vitest";
import { HOST_TEMPLATES, seedFromHostTemplate } from "@/lib/client-templates";

/**
 * The host-template SEED logic now lives in the SDK
 * (`@mcpjam/sdk/host-config/templates`) and is locked there by a golden
 * snapshot. This file covers what stays the inspector client's
 * responsibility: the thin `client-templates.ts` adapter that re-attaches the
 * Vite logo assets and threads the Vite `__APP_VERSION__` build constant into
 * the SDK seed. (`__APP_VERSION__` is `"test"` under vitest — see
 * client/vitest.config.ts.)
 */
declare const __APP_VERSION__: string;

describe("client host-template adapter", () => {
  it("exposes every template with a non-empty logo (UI-only metadata)", () => {
    expect(HOST_TEMPLATES.length).toBeGreaterThanOrEqual(12);
    for (const template of HOST_TEMPLATES) {
      expect(template.logoSrc, `logo for ${template.id}`).toBeTruthy();
      expect(template.label).toBeTruthy();
    }
  });

  it("threads the inspector build version into the mcpjam template", () => {
    const config = seedFromHostTemplate("mcpjam") as {
      mcpProfile?: { initialize?: { clientInfo?: { version?: string } } };
    };
    expect(config.mcpProfile?.initialize?.clientInfo?.version).toBe(
      __APP_VERSION__,
    );
  });

  it("seeds the right host style per template via the SDK", () => {
    expect(
      (seedFromHostTemplate("claude") as { hostStyle: string }).hostStyle,
    ).toBe("claude");
    expect(
      (seedFromHostTemplate("chatgpt") as { hostStyle: string }).hostStyle,
    ).toBe("chatgpt");
  });

  it("HOST_TEMPLATES[].seed delegates to the same output as seedFromHostTemplate", () => {
    for (const template of HOST_TEMPLATES) {
      expect(template.seed({ theme: "dark" })).toEqual(
        seedFromHostTemplate(template.id, { theme: "dark" }),
      );
    }
  });
});
