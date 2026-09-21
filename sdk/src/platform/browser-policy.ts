import { z } from "zod";

const origin = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Expected an HTTP(S) origin without credentials, path, query or fragment");
const origins = z.tuple([origin]).rest(origin);
const tool = z.string().min(1).max(256);
const tools = z.tuple([tool]).rest(tool);
/** Nonempty restrictions and required allowlist grants are reflected in TS too. */
export const platformBrowserToolPolicySchema = z.union([
  z.strictObject({
    mode: z.literal("allow_all"),
    originAllowlist: origins.optional(),
  }),
  z.strictObject({
    mode: z.literal("read_only"),
    originAllowlist: origins.optional(),
  }),
  z.strictObject({
    mode: z.literal("allowlist"),
    originAllowlist: origins,
    toolAllowlist: tools.optional(),
  }),
  z.strictObject({
    mode: z.literal("allowlist"),
    originAllowlist: origins.optional(),
    toolAllowlist: tools,
  }),
]);
export type PlatformBrowserToolPolicy = z.infer<
  typeof platformBrowserToolPolicySchema
>;
