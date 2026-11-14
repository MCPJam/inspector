import type { Context } from "hono";
import { HOSTED_MODE, SANDBOX_HOSTS } from "../../../config.js";
import { openSandboxViewCapability } from "../../../services/sandbox-view-policy.js";
import { readHostedSandboxView } from "../../../services/sandbox-view-hosted.js";
import {
  sandboxViewHeaders,
  SANDBOX_VIEW_DENY_POLICY,
} from "../../../utils/sandbox-view-response.js";
import { reportRouteFailure } from "../../../utils/route-error-report.js";
import { renderSandboxProxyHtml } from "./sandbox-proxy-html.js";

export async function serveSandboxViewDocument(c: Context): Promise<Response> {
  for (const [name, value] of Object.entries(
    sandboxViewHeaders(SANDBOX_VIEW_DENY_POLICY),
  ))
    c.header(name, value);
  c.res.headers.delete("X-Frame-Options");
  if (c.req.method !== "GET") return c.text("Not Found", 404);
  if (!HOSTED_MODE) return c.text("App document admission required", 403);
  const host = c.req.header("Host") ?? "";
  const match = /^v-([a-f0-9]{16})\.(.+)$/.exec(host);
  if (!match || !SANDBOX_HOSTS.has(match[2])) return c.text("Not Found", 404);
  const origin = `https://${host}`;
  let identity: { keyHash: string; identityHash: string };
  try {
    identity = openSandboxViewCapability(c.req.query("view_token") ?? "", origin);
  } catch {
    return c.text("Not Found", 404);
  }
  try {
    const lease = await readHostedSandboxView(
      identity.keyHash,
      identity.identityHash,
    );
    if (
      !lease ||
      lease.expiresAt <= Date.now() ||
      lease.keyHash !== identity.keyHash ||
      lease.identityHash !== identity.identityHash ||
      lease.viewOrigin !== origin
    )
      return c.text("Not Found", 404);
    for (const [name, value] of Object.entries(
      sandboxViewHeaders(lease.policy),
    ))
      c.header(name, value);
    return c.html(
      renderSandboxProxyHtml({
        htmlSha256: lease.htmlHash,
        hostOrigin: lease.hostOrigin,
        admissionId: lease.keyHash,
      }),
    );
  } catch (error) {
    reportRouteFailure("App document lease could not be read", error, {
      source: "apps.view-document",
      hop: "mcpjam_internal",
    });
    return c.text("App document is temporarily unavailable", 503);
  }
}
