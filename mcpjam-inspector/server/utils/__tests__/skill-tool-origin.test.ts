import { afterEach, expect, it, vi } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import { createEffectiveSkillTools } from "../computers/effective-skill-tools";
import { withServerSkills } from "../server-skill-tools";
import { createPinnedSkillTools } from "../computers/cloud-skill-tools";
import { SKILL_TOOL_NAMES } from "@/shared/eval-matching";
import { toolOrigin } from "@/shared/tool-origin";
import {
  createAiSdkEvalTraceContext,
  registerAiSdkPrepareStep,
  wrapToolSetForEvalTrace,
} from "../../services/evals/eval-trace-capture";

afterEach(() => vi.restoreAllMocks());

it("marks all server skill tools builtin while keeping MCP identity authoritative", async () => {
  const manager = new MCPClientManager();
  vi.spyOn(manager, "getSkillsSupport").mockReturnValue({
    active: true,
    declared: true,
    advertised: true,
    directoryRead: false,
  });
  vi.spyOn(manager, "listServerSkills").mockResolvedValue({ skills: [] });
  const { tools } = withServerSkills(
    {},
    { manager, servers: [{ serverId: "server", serverLabel: "Server" }] },
  );
  for (const name of SKILL_TOOL_NAMES) {
    expect(Reflect.get(tools, name)).toHaveProperty("_toolOrigin", "builtin");
    expect(
      toolOrigin(name, { _toolOrigin: "builtin", _serverId: "external" }),
    ).toBe("mcp");
  }
  const context = createAiSdkEvalTraceContext(Date.now());
  registerAiSdkPrepareStep(context, 0);
  const traced = wrapToolSetForEvalTrace(tools, context);
  const listSkills = Reflect.get(traced, "listSkills");
  await listSkills.execute({}, { toolCallId: "call" });
  expect(
    context.recordedSpans.find((span) => span.toolCallId === "call"),
  ).toMatchObject({ toolOrigin: "builtin", toolName: "listSkills" });
});

it("records real pinned skill loading as builtin", async () => {
  const context = createAiSdkEvalTraceContext(Date.now());
  registerAiSdkPrepareStep(context, 0);
  const pinned = createPinnedSkillTools([
    {
      name: "example",
      description: "Example",
      content: "Instructions",
      contentHash: "hash",
    },
  ]);
  const traced = wrapToolSetForEvalTrace(pinned, context);
  expect(
    await traced.loadSkill.execute(
      { name: "example" },
      { toolCallId: "call", messages: [], context: {} },
    ),
  ).toContain("Instructions");
  expect(
    context.recordedSpans.find((span) => span.toolCallId === "call"),
  ).toMatchObject({ toolOrigin: "builtin", toolName: "loadSkill" });
});

it("tags resolved skill implementations without changing their policy", () => {
  const effective = createEffectiveSkillTools({
    skills: [],
    pluginRefs: new Set(),
    serverRefs: new Set(),
  });
  for (const definition of Object.values(effective))
    expect(definition).toHaveProperty("_toolOrigin", "builtin");
});
