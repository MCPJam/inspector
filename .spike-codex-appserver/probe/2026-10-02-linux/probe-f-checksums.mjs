// Probe (f): the checksum source for the vendored codex binaries.
//
// For each platform package of @openai/codex@0.149.1:
//   1. read the registry's published `dist` (integrity = sha512 SRI, shasum = sha1)
//   2. `npm pack` the tarball, verify sha512 (and sha1) against the registry
//   3. extract, sha256 every file the pack build will vendor:
//        package/vendor/<triple>/bin/*            (codex / codex.exe + siblings)
//        package/vendor/<triple>/codex-resources/bwrap   (if present)
//        package/vendor/<triple>/codex-path/rg[.exe]      (if present)
//   4. delete the tarball + extraction before the next one (~125 MB each)
//
// Writes codex-vendor-checksums.json (the spec'd shape) and
// codex-vendor-all-files.json (sha256 of EVERY file in each tarball, for audit).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, relative } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const WORK = join(HERE, "runs", "f");
const VERSION = "0.149.1";
const TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "win32-x64": "x86_64-pc-windows-msvc",
  // Not requested, but published as an optionalDependency of 0.149.1; recorded
  // so the pack build has it if it ever targets Windows on ARM.
  "win32-arm64": "aarch64-pc-windows-msvc",
};
const REQUESTED = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];

const hashFile = (path, algo) =>
  new Promise((resolve, reject) => {
    const h = createHash(algo);
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h))
      .on("error", reject);
  });

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
  });

const out = {};
const all = {};
const log = (...a) => console.log(new Date().toISOString(), ...a);
mkdirSync(WORK, { recursive: true });

for (const [target, triple] of Object.entries(TARGETS)) {
  const spec = `@openai/codex@${VERSION}-${target}`;
  log("registry dist for", spec);
  const dist = JSON.parse(
    execFileSync("npm", ["view", spec, "dist", "--json"], { encoding: "utf8" })
  );
  const dir = join(WORK, target);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  log("npm pack", spec);
  const packed = JSON.parse(
    execFileSync("npm", ["pack", spec, "--pack-destination", dir, "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
  );
  const tgz = join(dir, packed[0].filename);
  const size = statSync(tgz).size;
  const sha512 = `sha512-${(await hashFile(tgz, "sha512")).digest("base64")}`;
  const sha1 = (await hashFile(tgz, "sha1")).digest("hex");
  const integrityOk = sha512 === dist.integrity;
  const shasumOk = sha1 === dist.shasum;
  log(target, "tgz bytes", size, "integrity match:", integrityOk, "sha1 match:", shasumOk);
  if (!integrityOk || !shasumOk) {
    throw new Error(
      `${spec}: tarball does not match registry: computed ${sha512} / ${sha1}, registry ${dist.integrity} / ${dist.shasum}`
    );
  }
  const x = join(dir, "x");
  mkdirSync(x);
  execFileSync("tar", ["-xzf", tgz, "-C", x]);
  const pkgRoot = join(x, "package");
  const vendorRoot = join(pkgRoot, "vendor", triple);
  if (!existsSync(vendorRoot)) throw new Error(`${spec}: no vendor/${triple}`);
  const everything = {};
  for (const f of walk(pkgRoot).sort()) {
    everything[relative(pkgRoot, f)] = {
      sha256: `sha256:${(await hashFile(f, "sha256")).digest("hex")}`,
      bytes: statSync(f).size,
      mode: (statSync(f).mode & 0o777).toString(8),
    };
  }
  const exe = target.startsWith("win32") ? ".exe" : "";
  const want = (rel) =>
    rel.startsWith(`vendor/${triple}/bin/`) ||
    rel === `vendor/${triple}/codex-resources/bwrap` ||
    rel === `vendor/${triple}/codex-path/rg${exe}`;
  const files = Object.fromEntries(
    Object.entries(everything)
      .filter(([rel]) => want(rel))
      .map(([rel, v]) => [rel, v.sha256])
  );
  const mainBin = `vendor/${triple}/bin/codex${exe}`;
  if (!files[mainBin]) throw new Error(`${spec}: missing ${mainBin}`);
  out[target] = {
    npmPackage: "@openai/codex",
    version: `${VERSION}-${target}`,
    integrity: dist.integrity,
    triple,
    files,
    // Extra, beyond the spec'd shape: where it came from and the legacy sha1.
    tarball: dist.tarball,
    shasum: dist.shasum,
    requested: REQUESTED.includes(target),
  };
  all[target] = { spec, tarballBytes: size, integrity: dist.integrity, files: everything };
  log(target, "files:", JSON.stringify(files, null, 1));
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(join(HERE, "codex-vendor-checksums.json"), `${JSON.stringify(out, null, 2)}\n`);
  writeFileSync(join(HERE, "codex-vendor-all-files.json"), `${JSON.stringify(all, null, 2)}\n`);
}
log("done");
