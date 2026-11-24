/**
 * `draft_climb_change`: a model-written rewrite of one tool's description,
 * drawn from the failed iterations of the climb's steering cases. It saves
 * nothing and starts no run: the caller edits the draft, saves it as a mock
 * version with `update_mock_server` and submits that version as a round.
 */
import { z } from "zod";
import type { PlatformOperation } from "./operations.js";
import { suitePermalink } from "./climb-operations.js";
import { climbInput, projectInput, resolveClimbProject, text, type WithProject } from "./climb-support.js";
import type { PlatformClimbDraft } from "./climb-types.js";

const MAX_CASES = 10;

const draftInput = z.object({
  project: projectInput,
  climb: climbInput,
  tool: text
    .max(200)
    .describe("The tool whose description to rewrite. A steering case of the climb must call it; `get_climb` lists the steering cases and their tools under `groups.steeringCases`."),
  cases: z
    .array(text)
    .max(MAX_CASES)
    .optional()
    .describe(`Steering case keys of that tool to draft from, ${MAX_CASES} at most. Omit for the steering cases the latest round failed, else the ones the baseline failed.`),
  includeTitle: z.boolean().optional().describe("Also propose a title for the tool."),
});

export type DraftClimbChangeInput = z.infer<typeof draftInput>;
export type DraftClimbChangeResult = WithProject<PlatformClimbDraft>;

export const draftClimbChangeOperation: PlatformOperation<DraftClimbChangeInput, DraftClimbChangeResult> = {
  name: "draft_climb_change",
  title: "Draft a change for a climb",
  description:
    "Draft a rewritten description (and, on request, a title) for one tool of a climb, written by a model from the tool's current listing, its sibling tool names and what the failed steering cases expected and did. Returns the draft and `patchJson`, a merge patch of the mock definition ({\"tools\":{\"<tool>\":{\"description\":...}}}) that `update_mock_server` takes as `patch`. It saves nothing, starts no run and never reads validation or confirmation cases. Included with MCPJam: no credits of the climb are used, and MCPJam's daily drafting budget applies. One draft at a time per climb. The real server must have been inspected once.",
  readOnly: false,
  risk: "none",
  permalink: suitePermalink,
  inputSchema: draftInput,
  async execute(input, context) {
    const { project, info } = await resolveClimbProject(context, input.project);
    const draft = await context.client.draftClimbChange(
      {
        projectId: project.id,
        climbId: input.climb,
        toolName: input.tool,
        ...(input.cases ? { failedCaseKeys: input.cases } : {}),
        ...(input.includeTitle ? { includeTitle: true } : {}),
      },
      { signal: context.signal }
    );
    return { ...draft, project: info };
  },
};
