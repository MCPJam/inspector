import fs from "node:fs";
import path from "node:path";

const inspectorDir = process.cwd();
const localSdkLink = path.join(inspectorDir, "node_modules", "@mcpjam", "sdk");
const expectedSdkDir = path.resolve(inspectorDir, "../sdk");

function normalizePath(targetPath) {
  return process.platform === "win32"
    ? targetPath.replace(/\\/g, "/").toLowerCase()
    : targetPath;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(localSdkLink)) {
  fail(`Expected linked SDK at ${localSdkLink}, but it does not exist.`);
}

if (!fs.existsSync(expectedSdkDir)) {
  fail(
    `Expected sibling SDK checkout at ${expectedSdkDir}, but it does not exist.`,
  );
}

const linkStats = fs.lstatSync(localSdkLink);
if (!linkStats.isSymbolicLink()) {
  fail(
    `Expected ${localSdkLink} to be a local npm link/junction to ../sdk, but it is not a symlink.`,
  );
}

const resolvedLinkedSdk = fs.realpathSync(localSdkLink);
const resolvedExpectedSdk = fs.realpathSync(expectedSdkDir);

if (normalizePath(resolvedLinkedSdk) !== normalizePath(resolvedExpectedSdk)) {
  fail(
    `Expected @mcpjam/sdk to resolve to ${resolvedExpectedSdk}, but it resolved to ${resolvedLinkedSdk}.`,
  );
}

const sdkPackageJsonPath = path.join(resolvedLinkedSdk, "package.json");
if (!fs.existsSync(sdkPackageJsonPath)) {
  fail(
    `Expected SDK package manifest at ${sdkPackageJsonPath}, but it does not exist.`,
  );
}

const sdkPackage = JSON.parse(fs.readFileSync(sdkPackageJsonPath, "utf8"));
if (sdkPackage.name !== "@mcpjam/sdk") {
  fail(
    `Expected linked package name to be @mcpjam/sdk, but found ${sdkPackage.name ?? "unknown"}.`,
  );
}

console.log(
  `Verified repo-local SDK link: ${localSdkLink} -> ${resolvedLinkedSdk}`,
);
