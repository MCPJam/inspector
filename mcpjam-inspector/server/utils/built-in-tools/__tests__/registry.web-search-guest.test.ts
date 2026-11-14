import { describe, expect, it } from "vitest";
import { resolveHostTools } from "../registry";
import { WEB_SEARCH_TOOL_NAME } from "../exa-web-search";

// The backend refuses every guest search outside a shared scenario (a guest has
// no wallet to charge; a scenario visitor bills its owner), so the registry
// must not advertise a tool that can only fail at execution.
describe("resolveHostTools — web_search for guests", () => {
  const config = { builtInToolIds: [WEB_SEARCH_TOOL_NAME] };
  const base = { authHeader: "Bearer token", projectId: "project-1" };

  it("withholds web_search from a guest outside a scenario", () => {
    expect(
      resolveHostTools(config, { ...base, isGuest: true }),
    ).toBeUndefined();
  });

  it("keeps web_search for a guest visiting a shared scenario", () => {
    const tools = resolveHostTools(config, {
      ...base,
      isGuest: true,
      scenarioId: "scenario-1",
    });
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("keeps web_search for a signed-in caller", () => {
    const tools = resolveHostTools(config, base);
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });
});
