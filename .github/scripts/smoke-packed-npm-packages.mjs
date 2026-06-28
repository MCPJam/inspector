import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const rootDir = process.cwd();
const expectedMcpClientPackage = "@modelcontextprotocol/client";
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

const expectedClientVersion = readExpectedMcpClientVersion(packagesToPack);
const tmpRoot = mkdtempSync(path.join(tmpdir(), "mcpjam-pack-smoke-"));

try {
  const packDir = path.join(tmpRoot, "packs");
  mkdirSync(packDir, { recursive: true });

  const tarballs = packagesToPack.map((pkg) => packWorkspace(pkg, packDir));
  const installDir = path.join(tmpRoot, "install");

  mkdirSync(installDir, { recursive: true });
  run("npm", ["init", "-y"], { cwd: installDir });
  run("npm", ["install", "--legacy-peer-deps", ...tarballs], { cwd: installDir });

  assertInstalledMcpClientVersion(installDir, expectedClientVersion);

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

function readExpectedMcpClientVersion(packages) {
  const specs = new Set();

  for (const pkg of packages) {
    const packageJson = JSON.parse(
      readFileSync(path.join(rootDir, pkg.dir, "package.json"), "utf8"),
    );
    const spec =
      packageJson.dependencies?.[expectedMcpClientPackage] ??
      packageJson.devDependencies?.[expectedMcpClientPackage] ??
      packageJson.peerDependencies?.[expectedMcpClientPackage];

    if (!spec) {
      continue;
    }

    if (!exactVersionPattern.test(spec)) {
      throw new Error(
        `${pkg.workspace} must pin ${expectedMcpClientPackage} exactly, got ${JSON.stringify(spec)}.`,
      );
    }

    specs.add(spec);
  }

  if (specs.size !== 1) {
    throw new Error(
      `Expected one ${expectedMcpClientPackage} version across packed packages, got: ${
        [...specs].join(", ") || "<none>"
      }`,
    );
  }

  return [...specs][0];
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

function assertInstalledMcpClientVersion(installDir, expectedVersion) {
  const result = spawnSync(
    "npm",
    ["ls", expectedMcpClientPackage, "--all", "--json"],
    {
      cwd: installDir,
      encoding: "utf8",
    },
  );

  if (result.error) {
    throw new Error(
      `npm ls ${expectedMcpClientPackage} failed to start: ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `npm ls ${expectedMcpClientPackage} failed with exit code ${result.status}:\n${
        result.stderr || result.stdout || "<no output>"
      }`,
    );
  }

  let tree;
  try {
    tree = JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(
      `npm ls ${expectedMcpClientPackage} did not return valid JSON: ${error.message}`,
    );
  }

  const versions = collectDependencyVersions(tree, expectedMcpClientPackage);

  if (versions.length === 0) {
    throw new Error(`${expectedMcpClientPackage} was not installed in packed smoke project.`);
  }

  const unexpectedVersions = [...new Set(versions)].filter(
    (version) => version !== expectedVersion,
  );

  if (unexpectedVersions.length > 0) {
    throw new Error(
      `${expectedMcpClientPackage} resolved to ${unexpectedVersions.join(
        ", ",
      )}; expected ${expectedVersion}.`,
    );
  }

  console.log(`${expectedMcpClientPackage} resolved to ${expectedVersion}.`);
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
  const child = spawn("npx", ["--no-install", "inspector", "--port", port], {
    cwd: installDir,
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

  child.kill("SIGTERM");
  await waitForExit(child, 5000);
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
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
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
