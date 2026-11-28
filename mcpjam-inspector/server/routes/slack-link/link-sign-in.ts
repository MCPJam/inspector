/**
 * The last step of both account-link pages (Slack and Discord), once the
 * person has signed in to the link app.
 *
 * The pages hand that sign-in's access token to the backend's consume route,
 * which verifies it and takes the user and organization from it; they no
 * longer look either up or name them. The same token lists the person's
 * projects for the Slack page's picker, so nothing here acts as anyone.
 */
import { logger } from "../../utils/logger.js";

const REQUEST_TIMEOUT_MS = 10_000;

/** The pages a refused consume can show. */
export type LinkRefusalPage = "no_account" | "no_organization" | "failed";

/**
 * Which page a refused consume shows. Only the two causes the person can fix
 * themselves get their own page; every other reason (a bad or reused token, a
 * non-member, an expired session) shares the generic failure page, so the
 * page never says which check a captured link failed.
 */
export function linkRefusalPage(reason: string | undefined): LinkRefusalPage {
  switch (reason) {
    case "unknown_mcpjam_user":
      return "no_account";
    case "org_unresolved":
      return "no_organization";
    default:
      return "failed";
  }
}

export interface LinkPickerProject {
  id: string;
  name: string;
}

/**
 * The person's projects in the organization the link landed in, read with
 * their own link-app token. Best effort: the link has already succeeded, so
 * any failure gives an empty list and the page falls back to a paste field.
 */
export async function listLinkPickerProjects(
  accessToken: string,
  organizationId: string | undefined,
): Promise<LinkPickerProject[]> {
  const convexHttpUrl = (process.env.CONVEX_HTTP_URL ?? "").replace(/\/+$/, "");
  if (!convexHttpUrl || !organizationId) return [];
  const url = new URL(`${convexHttpUrl}/v1/projects`);
  url.searchParams.set("organizationId", organizationId);

  // The deadline covers the body too: this runs while the person waits on
  // the success page.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn("[link] project list for the picker was refused", {
        status: response.status,
      });
      return [];
    }
    const body = (await response.json()) as {
      items?: Array<{ id?: unknown; name?: unknown }>;
      data?: Array<{ id?: unknown; name?: unknown }>;
    };
    return (body.items ?? body.data ?? [])
      .filter((row) => typeof row?.id === "string")
      .map((row) => ({
        id: String(row.id),
        name:
          typeof row.name === "string" && row.name ? row.name : String(row.id),
      }));
  } catch (error) {
    logger.warn("[link] could not list projects for the picker", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timer);
  }
}
