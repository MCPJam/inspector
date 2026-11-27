import { describe, expect, it } from "vitest";
import {
  HOST_TEMPLATE_IDS,
  seedHostTemplate,
} from "../src/host-config/templates/index.js";
import { readEventsHostSetting } from "../src/host-config/events-support.js";
import { BUNDLED_HOST_COMPAT_CATALOG } from "../src/host-compat/catalog.generated.js";
import { getCatalogTemplate } from "../src/host-compat/catalog.js";

// A client seeded from the SDK and the same client from the backend catalog
// must receive MCP Events the same way. Nothing falls back to a default for a
// missing setting any more, so a template that forgets to save one silently
// becomes a client that receives no events.
describe("Events setting parity between SDK templates and the catalog", () => {
  const shared = HOST_TEMPLATE_IDS.filter(
    (id) => getCatalogTemplate(BUNDLED_HOST_COMPAT_CATALOG, id) !== undefined
  );

  it("compares at least the MCPJam and ChatGPT templates", () => {
    for (const id of [
      "mcpjam",
      "chatgpt",
      "chatgpt-desktop",
      "chatgpt-work",
      "chatgpt-work-desktop",
    ]) {
      expect(shared).toContain(id);
    }
  });

  it.each(shared)("%s saves the catalog's Events setting", (id) => {
    const catalog = getCatalogTemplate(BUNDLED_HOST_COMPAT_CATALOG, id);
    expect(readEventsHostSetting(seedHostTemplate(id))).toEqual(
      readEventsHostSetting(catalog)
    );
  });
});
