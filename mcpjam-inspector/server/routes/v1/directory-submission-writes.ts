/**
 * What a write to a directory submission sends the backend.
 *
 * THIS IS THE ONE VALIDATING PATH. Convex enforces structure, bounds, access,
 * the beta gate and the revision guard; what a field accepts, and how the
 * portal words a refusal, is the SDK flow's. So every value is checked here
 * before it is written, and stamped with the wording revision its writer saw
 * and the channel the gateway verified.
 */
import type { Context } from "hono";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  directoryFieldWordingRevision as wordingOf,
  directoryFlowField,
  validateDirectoryAnswerInput,
  type DirectoryAnswer,
  type DirectoryAnswerValue,
  type DirectoryFieldIssue,
  type DirectoryFlow,
  type DirectoryFlowField,
} from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { resolveAgentSurface } from "../../utils/agent-attribution.js";
import { readLaunchContext } from "../../utils/launch-context.js";
import { logger } from "../../utils/logger.js";
import { redactForLog } from "./redact-log-message.js";

type SetItem = {
  key: string;
  value: DirectoryAnswerValue;
  origin: "set" | "confirmed";
  wordingRevision?: string;
};
type ConfirmItem = { key: string; wordingRevision?: string };

/** A 400 that names the field and says what the portal would say. */
function refuse(issue: { key: string; message: string } & Partial<DirectoryFieldIssue>) {
  return new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    `${issue.key}: ${issue.message}`,
    { field: issue.key, step: issue.step, reason: issue.code },
  );
}

/**
 * A PATCH body as the backend's change, or a refusal of the first field the
 * portal's own controls could not hold. `null` removes an answer without a
 * field check: clearing an answer to a field the flow no longer has is how a
 * stale key goes away.
 */
export function planAnswerChange(
  flow: DirectoryFlow,
  stored: readonly DirectoryAnswer[],
  body: { answers?: Record<string, DirectoryAnswerValue>; confirm?: string[] },
) {
  const confirming = new Set(body.confirm ?? []);
  const answers = Object.entries(body.answers ?? {});
  const set: SetItem[] = [];
  const confirm: ConfirmItem[] = [];
  const unset: string[] = [];
  for (const [key, value] of answers) {
    if (value === null && confirming.has(key)) {
      throw refuse({ key, message: "Remove this answer or confirm it, not both." });
    }
    if (value === null) {
      unset.push(key);
      continue;
    }
    const issue = validateDirectoryAnswerInput(flow, key, value);
    if (issue) throw refuse(issue);
    // Set and confirmed at once is one entry: the backend takes each key once.
    const origin = confirming.has(key) ? "confirmed" : "set";
    set.push({ key, value, origin, wordingRevision: wordingOf(flow, key) });
  }
  const answered = new Set(answers.map(([key]) => key));
  const storedKeys = new Set(stored.map((answer) => answer.key));
  for (const key of confirming) {
    if (answered.has(key)) continue;
    // A blank value passes every shape check, so this refuses only a field
    // the flow does not have, in the flow's own words.
    const unknown = validateDirectoryAnswerInput(flow, key, null);
    if (unknown) throw refuse(unknown);
    const wordingRevision = wordingOf(flow, key);
    const preselected = directoryFlowField(flow, key)?.default;
    if (!storedKeys.has(key) && preselected !== undefined) {
      // The backend confirms only what it holds, and a default is derived,
      // never stored: store the preselection, confirmed.
      set.push({ key, value: preselected, origin: "confirmed", wordingRevision });
    } else {
      confirm.push({ key, wordingRevision });
    }
  }
  return {
    ...(set.length > 0 ? { set } : {}),
    ...(confirm.length > 0 ? { confirm } : {}),
    ...(unset.length > 0 ? { unset } : {}),
  };
}

/**
 * The channel a write arrived on, from the credential the gateway VERIFIED.
 * `cli` and `mcp` need a channel marker the gateway can verify, which does not
 * exist yet (see `agent-attribution.ts`); until then they read as `api`.
 */
export function writeChannel(c: Context): "web" | "api" | "agent" {
  switch (c.get("authMethod")) {
    // A verified session minted for this app's own audience: the web app.
    case "authkit_jwt":
      return "web";
    case "workos_agent":
    case "slack_service":
    case "discord_service":
      return "agent";
    default:
      return "api";
  }
}

/**
 * What an agent's answers are labelled with: the verified surface when it
 * names one, else the client's `x-mcpjam-launcher` declaration, which a run's
 * launcher badge also shows. Display only, never authorization, never the body.
 */
export function actorLabel(c: Context): string | undefined {
  const surface = resolveAgentSurface(c);
  if (surface === "slack") return "Slack";
  if (surface === "discord") return "Discord";
  const launcher = readLaunchContext(c)?.launcher;
  if (!launcher) {
    return c.get("authMethod") === "workos_agent" ? "Registered agent" : undefined;
  }
  // The backend refuses a label over 100 characters.
  return [launcher.client ?? launcher.kind, launcher.version]
    .filter(Boolean)
    .join(" ")
    .slice(0, 100);
}

const currentUser = makeFunctionReference<"query">("users:getCurrentUser");
const projectCapabilities = makeFunctionReference<"query">(
  "projects:getProjectCapabilities",
);
const organization = makeFunctionReference<"query">(
  "organizations:getOrganization",
);

/**
 * The facts the portal fills from the account: the caller's name and email
 * and the name of the project's organization. A value that cannot be read is
 * left empty, never guessed, and the create goes ahead.
 */
export async function accountPrefill(
  convex: ConvexHttpClient,
  projectId: string,
  flow: DirectoryFlow,
) {
  const fields = flow.steps.flatMap((step) =>
    step.fields.filter((field) => field.prefill),
  );
  const wanted = new Set(fields.map((field) => field.prefill));
  const [user, organizationName] = await Promise.all([
    wanted.has("account-name") || wanted.has("account-email")
      ? bestEffort<{ name?: string; email?: string } | null>(() =>
          convex.query(currentUser, {}),
        )
      : undefined,
    wanted.has("organization-name")
      ? bestEffort<string | undefined>(async () => {
          const project = await convex.query(projectCapabilities, { projectId });
          if (!project?.organizationId) return undefined;
          const { organizationId } = project;
          return (await convex.query(organization, { organizationId }))?.name;
        })
      : undefined,
  ]);
  const values: Record<NonNullable<DirectoryFlowField["prefill"]>, unknown> = {
    "account-name": user?.name,
    "account-email": user?.email,
    "organization-name": organizationName,
  };
  return fields.flatMap(({ key, prefill }) => {
    const value = prefill ? values[prefill] : undefined;
    return typeof value === "string" && value.trim()
      ? [{ key, value: value.trim(), wordingRevision: wordingOf(flow, key) }]
      : [];
  });
}

async function bestEffort<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    // A prefill is a convenience: the field stays empty for the person to fill.
    logger.warn("[v1.directory-submissions] could not read a prefill value", {
      detail: redactForLog(error),
    });
    return undefined;
  }
}
