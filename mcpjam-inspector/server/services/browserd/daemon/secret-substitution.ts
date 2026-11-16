/**
 * Substitutes a secret's value into an act at the last moment. The recorded
 * action (ledger, `/v1/trace`, mirror) keeps its `{{secret:NAME}}`
 * placeholders; the values travel beside the command.
 *
 * Throws on an unresolved placeholder: callers other than the planner reach
 * `execute`, and typing a literal placeholder would look like a wrong password.
 *
 * A secret sent with `origins` is typed only on a page at one of them, and a
 * reviewer credential only with them. The refusal is the act's result, so the
 * command ledger records it.
 */
import type { BrowserAction, BrowserCommandSecret } from "../protocol";
import { formatBrowserdError } from "../protocol";
import {
  secretNamesIn,
  substituteSecrets,
} from "../../../utils/secrets/secret-placeholders";
import { isReviewerSecretName } from "../../../utils/secrets/reviewer-secrets";
import { MIN_SCRUBBABLE_LENGTH } from "../../../../shared/secret-scrubber";
import type { CdpLike } from "./webmcp-bridge";

type ActAction = Extract<BrowserAction, { kind: "act" }>;

/** The page's `http(s)` origin, or `undefined` (`about:blank`, no page). */
function originOf(url: string | undefined): string | undefined {
  try {
    const { origin, protocol } = new URL(url ?? "");
    return /^https?:$/.test(protocol) ? origin : undefined;
  } catch {
    return undefined;
  }
}

/** An `http(s)` origin exactly as `URL` writes it: no path, no trailing slash. */
export const isWebOrigin = (value: string) => originOf(value) === value;

/** The origins a secret may be typed on; `undefined` means any page. */
const allowedOrigins = (secret: BrowserCommandSecret) =>
  secret.origins ?? (isReviewerSecretName(secret.name) ? [] : undefined);

/**
 * Where a substituted act's limited credentials may land, keyed by the act
 * `resolveActSecrets` returned: the page's origin is checked there, the
 * field's own document only once the driver has resolved the field.
 */
const receivingOrigins = new WeakMap<ActAction, readonly string[]>();

export const secretReceivingOrigins = (action: ActAction) =>
  receivingOrigins.get(action);

/** Refuses a secret this page may not receive. Names origins, never a value. */
function requireAllowedOrigin(secret: BrowserCommandSecret, pageUrl?: string) {
  const allowed = allowedOrigins(secret);
  const origin = originOf(pageUrl);
  if (!allowed || (origin && allowed.includes(origin))) return;
  const detail = allowed.length
    ? `"${secret.name}" can be typed only on ${allowed.join(", ")}, and this page is ${origin ?? "not on a web origin"}, so nothing was typed. Open the sign-in page on that origin, then type it there.`
    : `"${secret.name}" is a reviewer credential sent with no sign-in origin, so nothing was typed. Only MCPJam's reviewer sign-in can type it.`;
  throw new Error(formatBrowserdError("secret_origin_refused", detail));
}

/**
 * Returns the original object when nothing was substituted; the caller uses
 * that identity to decide whether to register secrets. `pageUrl` is the page
 * the act types into.
 */
export function resolveActSecrets(
  action: ActAction,
  secrets: ReadonlyArray<BrowserCommandSecret> | undefined,
  pageUrl?: string,
): ActAction {
  const values = new Map((secrets ?? []).map((s) => [s.name, s.value]));
  const sent = new Map((secrets ?? []).map((s) => [s.name, s]));
  // Behind the planner's own refusal: a value this short cannot be scrubbed
  // from what the page echoes back, so it is never typed.
  const texts = [
    ...(action.value === undefined ? [] : [action.value]),
    ...(action.fields ?? []).flatMap((field) =>
      typeof field.value === "string" ? [field.value] : [],
    ),
  ];
  let limit: readonly string[] | undefined;
  for (const name of new Set(texts.flatMap(secretNamesIn))) {
    const secret = values.get(name);
    if (secret !== undefined && secret.length < MIN_SCRUBBABLE_LENGTH) {
      throw new Error(
        formatBrowserdError(
          "secret_too_short",
          `"${name}" is shorter than ${MIN_SCRUBBABLE_LENGTH} characters, too ` +
            "short to hide reliably in what the page shows back; nothing was " +
            "typed. Ask the user to type it themselves.",
        ),
      );
    }
    const limited = sent.get(name);
    if (!limited) continue;
    requireAllowedOrigin(limited, pageUrl);
    const allowed = allowedOrigins(limited);
    if (allowed) {
      limit = limit ? limit.filter((entry) => allowed.includes(entry)) : allowed;
    }
  }
  const value =
    action.value === undefined
      ? undefined
      : substituteSecrets(action.value, values);
  const fields = action.fields?.map((field) =>
    typeof field.value === "string"
      ? { ...field, value: substituteSecrets(field.value, values) }
      : field,
  );
  // A `null` from `substituteSecrets` is "a placeholder had no value".
  if (value === null || fields?.some((field) => field.value === null)) {
    throw new Error(
      formatBrowserdError(
        "secret_unresolved",
        "this act referenced a {{secret:NAME}} the browser was not given a " +
          "value for; nothing was typed. Check the name, and that the secret " +
          "is set for this environment.",
      ),
    );
  }
  // Here, not only where a field is typed into: a direct command can carry a
  // limited credential on any verb (a dialog reply, say), and that verb may
  // never reach the field checks.
  if (limit && (action.verb !== "type" || !action.target || !("a11yRef" in action.target))) {
    throw new Error(
      formatBrowserdError(
        "secret_origin_refused",
        "a credential limited to a sign-in origin is typed only with `type` into a field named by a ref; nothing was typed",
      ),
    );
  }
  const valueChanged = value !== undefined && value !== action.value;
  const fieldsChanged =
    fields !== undefined &&
    fields.some((field, index) => field.value !== action.fields?.[index]?.value);
  if (!valueChanged && !fieldsChanged) return action;
  const resolved: ActAction = {
    ...action,
    ...(value === undefined ? {} : { value }),
    ...(fields === undefined
      ? {}
      : { fields: fields as NonNullable<ActAction["fields"]> }),
  };
  if (limit) receivingOrigins.set(resolved, limit);
  return resolved;
}

type FrameTree = {
  frame?: { id?: string; securityOrigin?: string };
  childFrames?: FrameTree[];
};

type FrameInfo = { id?: string; securityOrigin?: string };

function findFrame(
  tree: FrameTree | undefined,
  frameId?: string,
): FrameInfo | undefined {
  if (!tree?.frame) return undefined;
  if (frameId === undefined || tree.frame.id === frameId) return tree.frame;
  for (const child of tree.childFrames ?? []) {
    const found: FrameInfo | undefined = findFrame(child, frameId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Why a limited credential may not go into a field in `frameId` (the session's
 * own document when absent), or `undefined` when that frame's origin is one of
 * `origins`. The page's origin says nothing about an embedded frame's. Read
 * from Chrome's frame tree, which no script on the page can rewrite.
 */
export async function receivingFrameRefusal(
  cdp: CdpLike,
  frameId: string | undefined,
  origins: readonly string[],
): Promise<string | undefined> {
  let origin: string | undefined;
  try {
    const answer = (await cdp.send("Page.getFrameTree")) as
      | { frameTree?: FrameTree }
      | undefined;
    origin = findFrame(answer?.frameTree, frameId)?.securityOrigin;
  } catch {
    // A frame the browser cannot describe is refused below, like one elsewhere.
    origin = undefined;
  }
  if (origin && origins.includes(origin)) return undefined;
  const where = origin || "an origin the browser could not read";
  return `this field is in a document on ${where}, and the credential can be typed only on ${origins.join(", ") || "no page"}, so nothing was typed. Observe again and type it into the form on that origin.`;
}
