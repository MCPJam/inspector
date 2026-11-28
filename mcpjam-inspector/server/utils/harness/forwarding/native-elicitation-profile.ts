import { z } from "zod/v4";

// Measured initialize from CLI 2.1.245. 2.1.290 is admitted on the same form
// until a live requalification records a different profile. The CLI declares
// `roots`; MCPJam's own connection withholds it, as nothing there answers
// `roots/list`, so the profile admits the set with or without it.
const NATIVE_ELICITATION_RUNTIME_VERSIONS = new Set(["2.1.245", "2.1.290"]);
const formProfile = z.strictObject({
  elicitation: z.strictObject({ form: z.strictObject({}) }),
  roots: z.strictObject({ listChanged: z.literal(true) }).optional(),
});

export function isNativeElicitationProfile(
  capabilities: unknown,
  runtimeVersion?: string,
): boolean {
  return (
    runtimeVersion !== undefined &&
    NATIVE_ELICITATION_RUNTIME_VERSIONS.has(runtimeVersion) &&
    formProfile.safeParse(capabilities).success
  );
}
