/**
 * The eval-authoring skills, inlined as text for consumers that cannot read a
 * filesystem.
 *
 * `create-mcp-eval` is now a routing `SKILL.md` plus `references/`, which is
 * what progressive disclosure means for an agent that CAN follow a path. The
 * Inspector's "copy agent brief" button cannot: it puts one markdown blob on
 * the clipboard, and whoever pastes it has no `references/` directory to walk
 * into. Exporting only the routing file would silently drop ~90% of the brief
 * and leave the reader chasing links to nothing.
 *
 * So `SKILL_MD` stays WHOLE — assembled here from the same files the skill
 * ships, in reading order. One source of truth, two deliveries: the split
 * files for a filesystem consumer, the assembled text for the clipboard.
 */

import skillMd from "../skills/create-mcp-eval/SKILL.md";
import projectSetupMd from "../skills/create-mcp-eval/references/project-setup.md";
import sdkApiMd from "../skills/create-mcp-eval/references/sdk-api.md";
import patternsMd from "../skills/create-mcp-eval/references/patterns.md";
import templateMd from "../skills/create-mcp-eval/references/template.md";
import commonMistakesMd from "../skills/create-mcp-eval/references/common-mistakes.md";
import agentBriefMd from "../skills/create-mcp-eval/references/agent-brief.md";
import exploreSkillMd from "../skills/explore-to-sdk-evals/SKILL.md";

/** The reference files, in the order a reader works through them. */
export const CREATE_MCP_EVAL_REFERENCES = [
  projectSetupMd,
  sdkApiMd,
  patternsMd,
  templateMd,
  commonMistakesMd,
  agentBriefMd,
] as const;

/** Routing file only — for a consumer that can also fetch the references. */
export const CREATE_MCP_EVAL_SKILL_MD = skillMd;

/**
 * Routing file plus every reference, concatenated. This is what a clipboard
 * paste needs, and it is what `SKILL_MD` has always been.
 */
export const SKILL_MD = [skillMd, ...CREATE_MCP_EVAL_REFERENCES].join("\n\n");

export const EXPLORE_TO_SDK_EVALS_SKILL_MD = exploreSkillMd;
