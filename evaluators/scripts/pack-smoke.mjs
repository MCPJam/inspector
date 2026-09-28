import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "evaluators-consumer-"));
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, CI: "true" },
  });
try {
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", temp], root),
  );
  const tarball = join(temp, packed[0].filename);
  for (const manager of process.argv.includes("--pnpm")
    ? ["npm", "pnpm"]
    : ["npm"]) {
    const consumer = join(temp, manager);
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "clean-evaluator-consumer",
        private: true,
        type: "module",
      }),
    );
    run(
      manager,
      manager === "npm"
        ? [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            tarball,
            "typescript@5.9.3",
          ]
        : ["add", "--ignore-scripts", tarball, "typescript@5.9.3"],
      consumer,
    );
    writeFileSync(
      join(consumer, "smoke.mjs"),
      `import {assertion,runEvaluatorsProjected,normalizeMessages,toNamedEvaluator,evaluateToolCalls} from '@mcpjam/evaluators';\nconst results=await runEvaluatorsProjected([assertion({type:'responseContains',needle:'hello'})],{version:1,scenario:{title:'test'},trace:{messages:[]},transcript:{toolCalls:[],finalAssistantMessage:'hello'}});\nif(results[0].score!==1||toNamedEvaluator(results[0]).score!==1)throw Error('result');\nif(normalizeMessages({}).status!=='unsupported')throw Error('normalization');\nif(!evaluateToolCalls([{toolName:"search",arguments:{}}],[{toolName:"search",arguments:{}}]).passed)throw Error('matcher');\ntry{await import('@mcpjam/sdk');throw Error('unexpected SDK dependency')}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e}\ntry{await import('ai');throw Error('unexpected provider dependency')}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e}\n`,
    );
    run("node", ["smoke.mjs"], consumer);
    writeFileSync(
      join(consumer, "types.ts"),
      `import {assertion,runEvaluatorsProjected,type Evaluator,type EvaluatorResult} from '@mcpjam/evaluators';const evaluator:Evaluator=assertion({type:'responseContains',needle:'hello'});const result:Promise<EvaluatorResult[]>=runEvaluatorsProjected([evaluator],{version:1,scenario:{title:'case'},trace:{messages:[]},transcript:{toolCalls:[]}});void result;`,
    );
    run(
      join(consumer, "node_modules/.bin/tsc"),
      [
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "false",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--target",
        "es2022",
        "types.ts",
      ],
      consumer,
    );
    console.log(
      `${manager}: packed assertion, matcher, adapters, absent SDK/provider and declarations passed`,
    );
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
