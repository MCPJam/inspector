import { z } from "zod/v4";

// Measured initialize from CLI 2.1.245. Unknown fields require new qualification.
const formProfile = z.strictObject({
  elicitation: z.strictObject({ form: z.strictObject({}) }),
  roots: z.strictObject({ listChanged: z.literal(true) }),
});

export function isNativeElicitationProfile(
  capabilities: unknown,
  runtimeVersion?: string,
): boolean {
  return (
    runtimeVersion === "2.1.245" && formProfile.safeParse(capabilities).success
  );
}
