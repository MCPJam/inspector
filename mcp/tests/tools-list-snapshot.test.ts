/**
 * What the hosted server computes for each catalog tool on top of the SDK
 * catalog: which tools are listed (the beta hold list), their annotations, and
 * whether the description carries the spend notice. That code moves into the
 * SDK so local MCP can share it, and the move must leave this file unchanged.
 */
import { expect, it } from "vitest";
import { registerPlatformCatalogTools } from "../src/tools/platformTools.js";
import type { PlatformToolContext } from "../src/server.js";
import type { SessionToolRegistrar } from "../src/tools/sessionToolRegistrar.js";

it("lists the same catalog tools with the same annotations and spend notices", async () => {
  const tools: Array<Record<string, unknown>> = [];
  const registrar = {
    registerTool(
      name: string,
      config: { description?: string; annotations?: unknown }
    ) {
      tools.push({
        name,
        annotations: config.annotations,
        spendNotice: config.description?.includes("COSTS MONEY:") === true,
      });
      return {};
    },
  } as unknown as SessionToolRegistrar;
  // Registration reads nothing from the context; calls would.
  registerPlatformCatalogTools(registrar, {} as PlatformToolContext);
  await expect(`${JSON.stringify(tools, null, 2)}\n`).toMatchFileSnapshot(
    "./__snapshots__/platform-tools-list.json"
  );
});
