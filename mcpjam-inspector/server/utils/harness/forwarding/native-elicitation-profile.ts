import { z } from "zod/v4";

// What Claude Code CLI 2.1.290 declares on initialize to an HTTP server, read
// from the linux-x64 build the bridge lockfile pins (its built-in defaults):
// `roots: { listChanged: true }` and `elicitation: { form: {}, url: {} }`.
// Pass-through is admitted only when MCPJam declares exactly this and serves
// both modes, so moving the runtime pin needs a new reading of that handshake.
export const NATIVE_ELICITATION_RUNTIME = "2.1.290";
export const NATIVE_ELICITATION_MODES = ["form", "url"] as const;
const nativeProfile = z.strictObject({
  elicitation: z.strictObject({ form: z.strictObject({}), url: z.strictObject({}) }),
  roots: z.strictObject({ listChanged: z.literal(true) }),
});

export function isNativeElicitationProfile(
  capabilities: unknown,
  runtimeVersion?: string,
): boolean {
  return (
    runtimeVersion === NATIVE_ELICITATION_RUNTIME &&
    nativeProfile.safeParse(capabilities).success
  );
}
