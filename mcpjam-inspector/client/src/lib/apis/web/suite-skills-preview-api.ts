import { authFetch } from "@/lib/session-token";
import {
  suiteSkillsPreview,
  type SuiteSkillsPreview,
  type SuiteSkillsPreviewRequest,
} from "@/shared/pane-skills-preview";

/**
 * Which skills an eval run of each of a suite's environments would load, and
 * why it leaves the others out, in one request. An environment the backend
 * refuses to resolve comes back as its own entry with the refusal; a failed
 * read throws with the HTTP status in `cause`, for diagnostics.
 */
export async function fetchSuiteSkillsPreview(
  request: SuiteSkillsPreviewRequest,
  signal?: AbortSignal,
): Promise<SuiteSkillsPreview> {
  const response = await authFetch(
    "/api/web/environments/skills-preview/suite",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error("Couldn’t load the skills preview. Try again.", {
      cause: { status: response.status },
    });
  }
  return suiteSkillsPreview.parse(await response.json());
}
