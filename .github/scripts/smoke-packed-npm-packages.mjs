import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const rootDir = process.cwd();
const expectedMcpV2PackageVersion = "2.0.0-alpha.2";
const expectedMcpV2Packages = [
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/node",
  "@modelcontextprotocol/server",
];
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const packageSpecs = {
  sdk: { workspace: "@mcpjam/sdk", dir: "sdk", publish: boolEnv("PUBLISH_SDK") },
  cli: { workspace: "@mcpjam/cli", dir: "cli", publish: boolEnv("PUBLISH_CLI") },
  inspector: {
    workspace: "@mcpjam/inspector",
    dir: "mcpjam-inspector",
    publish: boolEnv("PUBLISH_INSPECTOR"),
  },
};

if (!packageSpecs.sdk.publish && (packageSpecs.cli.publish || packageSpecs.inspector.publish)) {
  packageSpecs.sdk.publish = true;
}

const packagesToPack = Object.values(packageSpecs).filter((pkg) => pkg.publish);

if (packagesToPack.length === 0) {
  console.log("No npm packages selected for smoke testing.");
  process.exit(0);
}

const expectedRuntimeMcpV2Versions = readExpectedMcpV2Versions(packagesToPack);
const tmpRoot = mkdtempSync(path.join(tmpdir(), "mcpjam-pack-smoke-"));

try {
  const packDir = path.join(tmpRoot, "packs");
  mkdirSync(packDir, { recursive: true });

  const tarballs = packagesToPack.map((pkg) => packWorkspace(pkg, packDir));
  const installDir = path.join(tmpRoot, "install");

  mkdirSync(installDir, { recursive: true });
  run("npm", ["init", "-y"], { cwd: installDir });
  run("npm", ["install", "--legacy-peer-deps", ...tarballs], { cwd: installDir });

  assertInstalledPackageVersions(installDir, expectedRuntimeMcpV2Versions);

  if (packageSpecs.cli.publish) {
    run("npx", ["--no-install", "mcpjam", "--help"], {
      cwd: installDir,
      env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: "1" },
    });
  }

  if (packageSpecs.inspector.publish) {
    await smokeInspectorStartup(installDir);
  }
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function boolEnv(name) {
  return process.env[name] === "true";
}

function readExpectedMcpV2Versions(packages) {
  const runtimeVersions = new Map();

  for (const pkg of packages) {
    const packageJson = JSON.parse(
      readFileSync(path.join(rootDir, pkg.dir, "package.json"), "utf8"),
    );

    for (const packageName of expectedMcpV2Packages) {
      for (const [section, runtime] of [
        ["dependencies", true],
        ["peerDependencies", false],
        ["devDependencies", false],
      ]) {
        const spec = packageJson[section]?.[packageName];

        if (!spec) {
          continue;
        }

        if (!exactVersionPattern.test(spec) || spec !== expectedMcpV2PackageVersion) {
          throw new Error(
            `${pkg.workspace} must pin ${packageName} to ${expectedMcpV2PackageVersion}, got ${JSON.stringify(
              spec,
            )}.`,
          );
        }

        if (runtime) {
          runtimeVersions.set(packageName, spec);
        }
      }
    }
  }

  return runtimeVersions;
}

function packWorkspace(pkg, packDir) {
  const output = capture("npm", [
    "pack",
    "--json",
    "--pack-destination",
    packDir,
    "-w",
    pkg.workspace,
  ]);
  const [packed] = JSON.parse(output);
  const filename = packed.filename;
  const tarball = path.isAbsolute(filename) ? filename : path.join(packDir, filename);

  console.log(`Packed ${pkg.workspace}: ${tarball}`);
  return tarball;
}

function assertInstalledPackageVersions(installDir, expectedVersions) {
  for (const [packageName, expectedVersion] of expectedVersions) {
    assertInstalledPackageVersion(installDir, packageName, expectedVersion);
  }
}

function assertInstalledPackageVersion(installDir, packageName, expectedVersion) {
  const result = spawnSync(
    "npm",
    ["ls", packageName, "--all", "--json"],
    {
      cwd: installDir,
      encoding: "utf8",
    },
  );

  if (result.error) {
    throw new Error(
      `npm ls ${packageName} failed to start: ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `npm ls ${packageName} failed with exit code ${result.status}:\n${
        result.stderr || result.stdout || "<no output>"
      }`,
    );
  }

  let tree;
  try {
    tree = JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `npm ls ${packageName} did not return valid JSON: ${error.message}`,
    );
  }

  const versions = collectDependencyVersions(tree, packageName);

  if (versions.length === 0) {
    throw new Error(`${packageName} was not installed in packed smoke project.`);
  }

  const unexpectedVersions = [...new Set(versions)].filter(
    (version) => version !== expectedVersion,
  );

  if (unexpectedVersions.length > 0) {
    throw new Error(
      `${packageName} resolved to ${unexpectedVersions.join(
        ", ",
      )}; expected ${expectedVersion}.`,
    );
  }

  console.log(`${packageName} resolved to ${expectedVersion}.`);
}

function collectDependencyVersions(node, packageName, versions = []) {
  if (!node?.dependencies) {
    return versions;
  }

  const match = node.dependencies[packageName];
  if (match?.version) {
    versions.push(match.version);
  }

  for (const dependency of Object.values(node.dependencies)) {
    collectDependencyVersions(dependency, packageName, versions);
  }

  return versions;
}

async function smokeInspectorStartup(installDir) {
  const port = String(62000 + Math.floor(Math.random() * 1000));
  const inspectorBin = path.join(
    installDir,
    "node_modules",
    "@mcpjam",
    "inspector",
    "bin",
    "start.js",
  );
  const child = spawn(process.execPath, [inspectorBin, "--port", port], {
    cwd: installDir,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      MCPJAM_INSPECTOR_DISABLE_ORPHAN_CHECK: "1",
      MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  const earlyExit = await waitForEarlyExit(child, 8000);
  if (earlyExit) {
    throw new Error(`Inspector smoke exited early with code ${earlyExit.code}:\n${output}`);
  }

  await terminateChildProcess(child, 5000);
  console.log("Inspector startup smoke stayed alive long enough to pass.");
}

function waitForEarlyExit(child, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, ms);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, ms);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

async function terminateChildProcess(child, gracefulMs) {
  sendSignal(child, "SIGTERM");

  if (!await waitForExit(child, gracefulMs)) {
    sendSignal(child, "SIGKILL");
    await waitForExit(child, 2000);
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

function sendSignal(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }

  return result.stdout;
}
