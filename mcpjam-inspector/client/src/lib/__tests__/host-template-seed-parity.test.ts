import { describe, it, expect } from "vitest";
import { HOST_TEMPLATES, seedFromHostTemplate } from "@/lib/client-templates";
import { seedHostTemplate } from "@mcpjam/sdk/host-config/templates";

/**
 * Guards the Node-safe host-template seed extraction: the SDK's
 * `seedHostTemplate` (used by the server `--template` resolver and the CLI)
 * must produce byte-identical config to the inspector client's original
 * `seedFromHostTemplate` for every template id and theme. The client passes
 * the Vite `__APP_VERSION__`; the SDK takes it as `appVersion` (only the
 * mcpjam template reads it). If this drifts, server-created template hosts
 * would no longer match what the UI mints.
 */
declare const __APP_VERSION__: string;

describe("host-template seed parity (client vs SDK)", () => {
  const themes = ["light", "dark"] as const;
  for (const template of HOST_TEMPLATES) {
    for (const theme of themes) {
      it(`${template.id} / ${theme} seeds identically`, () => {
        const fromClient = seedFromHostTemplate(template.id, { theme });
        const fromSdk = seedHostTemplate(template.id, {
          theme,
          appVersion: __APP_VERSION__,
        });
        expect(fromSdk).toEqual(fromClient);
      });
    }
  }
});
