/** Session grants are immutable; current host restrictions are additional ceilings. */
import { z } from "zod";
import {
  BROWSER_OBSERVATION_TOOL_NAMES,
  BROWSER_TOOL_NAMES,
  type BrowserUnattendedPolicy,
} from "./client-fulfilled-tools";

const origin = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error();
      return url.origin;
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "Expected an HTTP(S) origin without credentials, path, query or fragment",
      });
      return z.NEVER;
    }
  });
const sorted = (entries: string[]) => [...new Set(entries)].sort();
export const browserSessionPolicySchema = z
  .strictObject({
    mode: z.enum(["allow_all", "read_only", "allowlist"]),
    originAllowlist: z
      .array(origin)
      .min(1)
      .max(100)
      .transform(sorted)
      .optional(),
    toolAllowlist: z
      .array(z.string().trim().min(1).max(256))
      .min(1)
      .max(100)
      .transform(sorted)
      .optional(),
  })
  .superRefine((policy, ctx) => {
    if (policy.toolAllowlist && policy.mode !== "allowlist")
      ctx.addIssue({
        code: "custom",
        message: "toolAllowlist requires allowlist mode",
      });
    if (
      policy.mode === "allowlist" &&
      !policy.originAllowlist &&
      !policy.toolAllowlist
    )
      ctx.addIssue({
        code: "custom",
        message: "allowlist requires origins or tools",
      });
    for (const name of policy.toolAllowlist ?? []) {
      if (!BROWSER_TOOL_NAMES.includes(name) && !/^webmcp:.+/.test(name))
        ctx.addIssue({
          code: "custom",
          message: `Unknown browser tool: ${name}`,
        });
    }
  });
export type BrowserSessionPolicy = z.infer<typeof browserSessionPolicySchema>;

/** Null is unrestricted, [] denies everything. Never serialize [] as absent. */
export type EffectiveBrowserPolicy = {
  tools: readonly string[] | null;
  origins: readonly string[] | null;
};
export function compileBrowserPolicy(
  policy: BrowserUnattendedPolicy,
): EffectiveBrowserPolicy {
  return {
    tools:
      policy.mode === "read_only"
        ? [...BROWSER_OBSERVATION_TOOL_NAMES]
        : policy.mode === "allowlist" && policy.toolAllowlist?.length
        ? sorted([...policy.toolAllowlist])
        : null,
    origins: policy.originAllowlist?.length
      ? sorted([...policy.originAllowlist])
      : null,
  };
}
function originSubset(candidate: string, ceiling: string): boolean {
  if (candidate === ceiling) return true;
  // Legacy host configs permit bare hostnames on any port/scheme. Preserve
  // that meaning while allowing new session grants to specify exact origins.
  if (!ceiling.includes("://") && candidate.includes("://")) {
    try {
      return new URL(candidate).hostname === ceiling;
    } catch {
      return false;
    }
  }
  return false;
}
function intersect(
  a: readonly string[] | null,
  b: readonly string[] | null,
  subset = (x: string, y: string) => x === y,
): readonly string[] | null {
  if (a === null) return b;
  if (b === null) return a;
  return sorted([
    ...a.filter((x) => b.some((y) => subset(x, y))),
    ...b.filter((y) => a.some((x) => subset(y, x))),
  ]);
}
export function intersectBrowserPolicies(
  ...policies: EffectiveBrowserPolicy[]
): EffectiveBrowserPolicy {
  return policies.reduce(
    (a, b) => ({
      tools: intersect(a.tools, b.tools),
      origins: intersect(a.origins, b.origins, originSubset),
    }),
    { tools: null, origins: null },
  );
}
export function browserPolicyWithin(
  requested: EffectiveBrowserPolicy,
  ceiling: EffectiveBrowserPolicy,
): boolean {
  const within = (
    a: readonly string[] | null,
    b: readonly string[] | null,
    subset = (x: string, y: string) => x === y,
  ) =>
    b === null || (a !== null && a.every((x) => b.some((y) => subset(x, y))));
  return (
    within(requested.tools, ceiling.tools) &&
    within(requested.origins, ceiling.origins, originSubset)
  );
}
export function browserPolicyAllowsTool(
  policy: EffectiveBrowserPolicy,
  name: string,
): boolean {
  return policy.tools === null || policy.tools.includes(name);
}
export function browserPolicyAllowsOrigin(
  policy: EffectiveBrowserPolicy,
  url: string,
): boolean {
  if (policy.origins === null) return true;
  try {
    return policy.origins.some((rule) =>
      originSubset(new URL(url).origin, rule),
    );
  } catch {
    return false;
  }
}
