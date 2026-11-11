/**
 * Copilot CLI skills: the gate for `copilotCliAdapter.supportsSkills`.
 *
 * No adapter writes Copilot CLI's skills: the box writer fills its folder, and
 * the SDK's empty mode loads nothing until MCPJam's bridge opts in. So these
 * tests check that the bridge's session settings load exactly that folder,
 * expose the `skill` tool and no other built-in, and that the bridge the
 * recipe installs on the box carries them.
 */
import { describe, expect, it } from "vitest";
import { boxSkillsFolder, planBoxSkills } from "../box-skills-writer";
import { sessionSkillsAndTools } from "../copilot-cli/bridge/session-skills";
import { createCopilotCli } from "../copilot-cli/index";
import type { RuntimeSkill } from "../runtime-skills";
import { HARNESS_SKILLS } from "../skills-descriptor";
import { BOX_HOME } from "../../../test/support/fake-skill-box";

const descriptor = HARNESS_SKILLS["copilot-cli"];

const skill = (name: string): RuntimeSkill => ({
  skillId: `sk_${name}`,
  name,
  description: `The ${name} skill.`,
  content: `# ${name}`,
  aggregateHash: `hash-${name}`,
});

describe("Copilot CLI skills", () => {
  it("loads the box writer's folder and no other skills", () => {
    const settings = sessionSkillsAndTools(BOX_HOME, ["search"]);

    expect(settings.enableSkills).toBe(true);
    expect(settings.skillDirectories).toEqual([
      boxSkillsFolder(descriptor, BOX_HOME),
    ]);
    expect(descriptor.readFolders).toEqual([descriptor.writeFolder]);
    // Discovery would add the `.claude`, `.agents` and `.github` skill
    // folders above the working directory, other clients' among them.
    expect(settings.enableConfigDiscovery).toBe(false);
    expect(settings.disabledSkills).toEqual([
      "customize-cloud-agent",
      "github-pr-media",
    ]);
  });

  it("exposes the host's tools and the skill tool, and no other built-in", () => {
    const settings = sessionSkillsAndTools(BOX_HOME, ["search", "fetch"]);

    // An allow list: a tool it doesn't name is off.
    expect(settings.availableTools).toEqual([
      "custom:search",
      "custom:fetch",
      "builtin:skill",
    ]);
    // An exclusion wins over the allow list, so none may match the skill tool.
    expect(settings.excludedTools).toEqual(["mcp:*"]);
  });

  it("installs a bridge that opens every session with these settings", async () => {
    const recipe = await createCopilotCli({
      model: "openai/gpt-5.5",
      auth: { COPILOT_MODEL_PROXY_PLACEHOLDER: "test" },
    }).getBootstrap!();
    const bridge = recipe.files.find((file) =>
      file.path.endsWith("/bridge.mjs"),
    )!.content;

    // The bundle as esbuild writes it, which may suffix a renamed binding.
    expect(bridge).toMatch(/\.\.\.sessionSkillsAndTools\d*\(\s*homedir\d*\(\)/);
    expect(bridge).toContain("enableSkills: true");
    expect(bridge).toContain('".copilot/skills"');
    expect(bridge).toContain('"builtin:skill"');
    expect(bridge).toContain("enableConfigDiscovery: false");
    expect(bridge).not.toContain('"builtin:*"');
  });

  it("leaves off a skill named like a built-in, which the session hides", () => {
    const plan = planBoxSkills(descriptor, [
      skill("github-pr-media"),
      skill("release-notes"),
    ]);

    expect(plan.deliver.map(({ name }) => name)).toEqual(["release-notes"]);
    expect(plan.skipped).toEqual([
      { skill: skill("github-pr-media"), reason: "invalid-skill-name" },
    ]);
  });
});
