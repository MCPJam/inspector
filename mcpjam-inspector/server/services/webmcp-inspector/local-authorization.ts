import { createHash } from "node:crypto";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveBrowserRollout } from "../../utils/computers/browser-rollout.js";
import {
  BROWSER_CONSENT_HEADER,
  verifyAndFingerprintBrowserConsent,
} from "../../utils/computers/browser-consent.js";
import { validateLocalProjectKey } from "../../utils/computers/local-machine.js";

export interface LocalInspectionScope {
  actorId?: string;
  ownerKey: string;
  profileKey: string;
  consentFingerprint: string;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function authorizeLocalInspection(
  c: Context,
  projectId?: string,
): Promise<LocalInspectionScope> {
  const verdict = await resolveBrowserRollout(c, true);
  if (!verdict.enabled || !verdict.actor)
    throw new HTTPException(404, {
      res: c.json(
        {
          error: "Local Browser is not available.",
          code: "local-browser-disabled",
        },
        404,
      ),
    });
  const fingerprint = await verifyAndFingerprintBrowserConsent(
    c.req.header(BROWSER_CONSENT_HEADER),
  );
  if (!fingerprint)
    throw new HTTPException(403, {
      res: c.json(
        {
          error: "Allow Browser to inspect websites on this device.",
          code: "browser_consent_required",
        },
        403,
      ),
    });
  const ownerKey = hash([
    verdict.actor.guest ? "guest" : "member",
    verdict.actor.id,
  ]);
  return {
    actorId: verdict.actor.id,
    ownerKey,
    profileKey: inspectionProfileKey(ownerKey, projectId),
    consentFingerprint: fingerprint,
  };
}
export function inspectionProfileKey(
  ownerKey: string,
  projectId?: string,
): string {
  return hash([
    "webmcp-v2",
    ownerKey,
    projectId === undefined
      ? ["standalone"]
      : ["project", validateLocalProjectKey(projectId)],
  ]);
}
export function inspectionPartition(
  scope: Pick<LocalInspectionScope, "profileKey">,
): string {
  return `persist:mcpjam-webmcp-v2-${scope.profileKey}`;
}
export function inspectionNonceScope(
  sessionId: string,
  scope: LocalInspectionScope,
): string {
  return hash(["webmcp-frames", sessionId, scope.ownerKey, scope.profileKey]);
}
