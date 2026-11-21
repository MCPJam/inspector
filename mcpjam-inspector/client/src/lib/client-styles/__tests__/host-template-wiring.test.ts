import { describe, expect, it } from "vitest";
import {
  HOST_TEMPLATE_IDS,
  seedFromHostTemplate,
} from "@mcpjam/sdk/host-config/templates";
import { getHostLogoSrc } from "@/lib/host-ui-metadata";
import { getScenarioHostLogo } from "@/lib/scenario-client-style";
import { BUILT_IN_HOST_STYLES } from "../built-ins";

/**
 * The SDK owns the template list and the client owns each template's chrome,
 * so a template added only in the SDK seeds a host style the client has never
 * heard of. Unregistered styles fall back to the default style everywhere, so
 * nothing else fails loudly.
 */
describe("every SDK host template has client wiring", () => {
  const builtInIds = new Set(BUILT_IN_HOST_STYLES.map((style) => style.id));

  it.each(HOST_TEMPLATE_IDS)("%s", (templateId) => {
    const { hostStyle } = seedFromHostTemplate(templateId);
    expect(
      builtInIds.has(hostStyle),
      `Template "${templateId}" seeds hostStyle "${hostStyle}", which is not in BUILT_IN_HOST_STYLES. Add it in mcpjam-inspector/client/src/lib/client-styles/built-ins.ts.`,
    ).toBe(true);

    for (const theme of ["light", "dark"] as const) {
      expect(
        getHostLogoSrc(hostStyle, theme),
        `Host "${hostStyle}" (${theme}) has a different logo in LOGO_BY_HOST_ID than in its host style. Update mcpjam-inspector/client/src/lib/host-ui-metadata.ts to match built-ins.ts.`,
      ).toBe(getScenarioHostLogo(hostStyle, undefined, theme));
    }
  });
});
