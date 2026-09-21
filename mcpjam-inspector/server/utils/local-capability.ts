/** Shared mechanics only; each caller owns its grant policy and lock boundary. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, rename, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export function mintCapabilityToken(): string {
  return randomBytes(32).toString("base64url");
}
export function capabilityFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
export function capabilityMatches(
  token: string | null | undefined,
  hash: string,
): boolean {
  if (
    typeof token !== "string" ||
    token.length < 16 ||
    token.length > 256 ||
    !/^[0-9a-f]{64}$/.test(hash)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(capabilityFingerprint(token), "hex"),
    Buffer.from(hash, "hex"),
  );
}
export function createCapabilityMutationLock() {
  let chain: Promise<unknown> = Promise.resolve();
  return function withLock<T>(op: () => Promise<T>): Promise<T> {
    const run = chain.then(op, op);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
/** Caller must hold its mutation lock. Preserve the existing on-disk JSON format. */
export async function persistCapabilityState(
  file: string,
  state: unknown,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}
