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

/**
 * Prepended to the assembled blob.
 *
 * The routing file tells a reader to open `references/sdk-api.md` and friends
 * — correct for a filesystem consumer, and a dead end for a clipboard paste,
 * where those files do not exist. Without this line the split re-introduces
 * the very failure it was meant to prevent, in softer form: an agent follows
 * the reference map, cannot open the path, and either stalls or proceeds
 * without the API reference that is sitting 200 lines further down the same
 * paste.
 */
const INLINED_PREAMBLE = [
  "> **Note:** every file named in the reference map below is already inlined",
  "> in this document, in the order listed at the end. Do not try to open",
  "> `references/*.md` from disk — read on instead.",
  "",
].join("\n");

/** The reference files, in the order the reference map lists them. */
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
 *
 * Section numbering runs 1, 5, 2, 3, 4, 6, 7, 8 — the routing file keeps §1
 * and §5 because they are the decision rules a reader needs BEFORE any
 * reference, and the references follow in reference-map order. Stated here
 * because the numbers otherwise read as a mistake.
 */
export const SKILL_MD = [
  INLINED_PREAMBLE,
  skillMd,
  ...CREATE_MCP_EVAL_REFERENCES,
].join("\n\n");

export const EXPLORE_TO_SDK_EVALS_SKILL_MD = exploreSkillMd;
