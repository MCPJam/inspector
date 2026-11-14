const OLD_KEY = "proxy-addr@2.0.7";
const NEW_KEY = "proxy-addr@2.0.8";
const OLD_INTEGRITY = "sha512-llQsMLSUDUPT44jdrU/O37qlnifitDP+ZwrmmZcoSKyLKvtZxpyV0n2/bD/N4tBAAZ/gJEdZU7KMraoK1+XYAg==";
const NEW_INTEGRITY = "sha512-5nnx0yGyVUcY6t9RnWcARWtwT9F1D8O9rt08htPvnd49W1IgZtmLkhu9WfMzQj1cFxjHIO6connUNVW5k7AVyQ==";

// The two releases have the same dependency graph. Keep the vendor's frozen
// lockfile and replace only the vulnerable package, its integrity and references.
export function patchClaudeCodeBootstrapLock(lockfile: string): string {
  if (!lockfile.includes(OLD_KEY)) return lockfile;
  const resolution = `  ${OLD_KEY}:\n    resolution: {integrity: ${OLD_INTEGRITY}}`;
  if (
    !lockfile.includes(resolution) ||
    lockfile.includes(NEW_KEY) ||
    !lockfile.includes("proxy-addr: 2.0.7\n") ||
    lockfile.split(`  ${OLD_KEY}:\n`).length !== 3
  ) {
    throw new Error("The Claude bootstrap lockfile changed. Refresh its proxy-addr security patch before baking a sandbox.");
  }
  return lockfile
    .replace(resolution, `  ${NEW_KEY}:\n    resolution: {integrity: ${NEW_INTEGRITY}}`)
    .replaceAll(`${OLD_KEY}:`, `${NEW_KEY}:`)
    .replaceAll("proxy-addr: 2.0.7\n", "proxy-addr: 2.0.8\n");
}
