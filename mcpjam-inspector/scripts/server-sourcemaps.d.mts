/** Types for `server-sourcemaps.mjs`, which runs under bare Node from `build:server`. */
type VerifiedOutputs = { file: string; debugId: string }[];
export function verifyServerSourcemaps(dir: string): VerifiedOutputs;
export function injectServerSourcemaps(dir: string): VerifiedOutputs;
export function uploadServerSourcemaps(
  dir: string,
  target: { release: string; dist: string; ids: string },
  cli?: (args: string[]) => void,
): boolean;
