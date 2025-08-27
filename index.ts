import { readFile, writeFile } from "fs/promises";
import path from "path";
import { loadAndValidateFiles, runAll, formatJUnit } from "./shared/ci-runner";

async function main() {
  try {
    const testsPath = process.env.INPUT_TESTS || process.argv[2];
    const envPath = process.env.INPUT_ENVIRONMENT || process.argv[3];
    const outputFormat = (process.env.INPUT_OUTPUT_FORMAT || process.argv[4] || "junit-xml").toLowerCase();

    if (!testsPath || !envPath) {
      console.error("Missing required inputs: tests and environment");
      process.exit(2);
    }

    const workspaceRoot = process.cwd();
    const [testsRaw, envRaw] = await Promise.all([
      readFile(path.resolve(workspaceRoot, testsPath), "utf8"),
      readFile(path.resolve(workspaceRoot, envPath), "utf8"),
    ]);

    let testsJson: any;
    let envJson: any;
    try {
      testsJson = JSON.parse(testsRaw);
      envJson = JSON.parse(envRaw);
    } catch (err: any) {
      console.error(`Invalid JSON: ${err?.message || err}`);
      process.exit(2);
    }

    const { tests, environment } = await loadAndValidateFiles(testsJson, envJson);
    const outcome = await runAll({ tests, environment, workspaceRoot, defaults: { concurrency: 4, timeoutMs: 30000, maxSteps: 10 } });

    if (outputFormat === "json") {
      const outPath = path.resolve(workspaceRoot, "mcp-results.json");
      await writeFile(outPath, JSON.stringify(outcome, null, 2), "utf8");
    } else {
      const xml = formatJUnit(outcome.results);
      const outPath = path.resolve(workspaceRoot, "mcp-results.xml");
      await writeFile(outPath, xml, "utf8");
    }

    if (!outcome.passed) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err: any) {
    console.error(err?.message || String(err));
    process.exit(2);
  }
}

main();

