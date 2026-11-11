import { authFetch } from "@/lib/session-token";
import {
  paneSkillsPreview,
  type PaneSkillsPreview,
  type PaneSkillsRequest,
} from "@/shared/pane-skills-preview";

/**
 * Which skills a client or an environment would load, and why it leaves the
 * others out. The Compare pane and the Evaluate page's skill hints both read
 * it, so they give one answer. Throws on any failure; each caller words its
 * own message.
 */
export async function fetchSkillsPreview(
  request: PaneSkillsRequest,
  signal?: AbortSignal,
): Promise<PaneSkillsPreview> {
  const response = await authFetch("/api/web/environments/skills-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Skills preview failed with status ${response.status}`);
  }
  return paneSkillsPreview.parse(await response.json());
}
