import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { Command, CommanderError } from "commander";
import { installUnknownSubcommandHelpGuard } from "../src/lib/unknown-subcommand-help.js";
import { runCli } from "./support/cli-run.js";

/**
 * A tree with one of each shape the guard must leave alone, configured the way
 * `main()` configures the real program.
 */
function buildProgram(): { program: Command; out: string[]; ran: string[] } {
  const out: string[] = [];
  const ran: string[] = [];
  const program = new Command()
    .name("tool")
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: (value) => out.push(value),
      writeErr: () => {},
    });
  installUnknownSubcommandHelpGuard(program);

  const group = program.command("group").option("--name <value>");
  group
    .command("leaf")
    .alias("lf")
    .argument("<files...>")
    .action((files: string[]) => {
      ran.push(`leaf ${files.join(",")}`);
    });
  group.command("other").action(() => {
    ran.push("other");
  });

  // Lists on its own and has subcommands, like `projects servers`.
  const both = program.command("both").action(() => {
    ran.push("both");
  });
  both.command("list").action(() => {
    ran.push("both list");
  });

  // A positional of its own: a leading operand is that, not a subcommand.
  const positional = program
    .command("positional")
    .argument("[target]")
    .action((target?: string) => {
      ran.push(`positional ${target}`);
    });
  positional.command("sub").action(() => {
    ran.push("positional sub");
  });

  return { program, out, ran };
}

async function parse(
  argv: string[],
): Promise<{ out: string; ran: string[]; error?: CommanderError }> {
  const { program, out, ran } = buildProgram();
  try {
    await program.parseAsync(argv, { from: "user" });
    return { out: out.join(""), ran };
  } catch (error) {
    assert.ok(error instanceof CommanderError);
    return { out: out.join(""), ran, error };
  }
}

function assertHelp(
  result: Awaited<ReturnType<typeof parse>>,
  usage: RegExp,
): void {
  assert.equal(result.error?.code, "commander.helpDisplayed");
  assert.match(result.out, usage);
  assert.deepEqual(result.ran, []);
}

test("an unknown subcommand with --help fails as it does without it", async () => {
  const withHelp = await parse(["group", "leef", "--help"]);
  const without = await parse(["group", "leef"]);

  assert.equal(withHelp.out, "");
  assert.equal(withHelp.error?.code, "commander.unknownCommand");
  assert.equal(withHelp.error?.message, without.error?.message);
  assert.match(withHelp.error?.message ?? "", /unknown command 'leef'/);
  assert.match(withHelp.error?.message ?? "", /Did you mean leaf\?/);
});

test("-h is caught the same way, and so is an unknown command at the root", async () => {
  const short = await parse(["group", "leef", "-h"]);
  assert.equal(short.error?.code, "commander.unknownCommand");

  const root = await parse(["nope", "--help"]);
  assert.equal(root.error?.code, "commander.unknownCommand");
  assert.equal(root.out, "");
});

test("valid help at the root, a group and a leaf is unchanged", async () => {
  assertHelp(await parse(["--help"]), /Usage: tool \[options\] \[command\]/);
  assertHelp(await parse(["group", "--help"]), /Usage: tool group/);
  assertHelp(
    await parse(["group", "leaf", "--help"]),
    /Usage: tool group leaf/,
  );
  assertHelp(await parse(["group", "lf", "--help"]), /Usage: tool group leaf/);
});

test("--help before the subcommand still shows the group's help", async () => {
  assertHelp(await parse(["group", "--help", "leef"]), /Usage: tool group/);
  assertHelp(await parse(["--help", "group"]), /Usage: tool \[options\]/);
});

test("an option value that looks like a command is not read as one", async () => {
  assertHelp(
    await parse(["group", "--name", "leef", "--help"]),
    /Usage: tool group/,
  );
});

test("operands after -- are left to Commander", async () => {
  const result = await parse(["group", "--", "leef", "--help"]);
  assert.equal(result.error?.code, "commander.unknownCommand");
  assert.equal(result.out, "");
});

test("a leaf's positional and variadic operands still allow --help", async () => {
  assertHelp(
    await parse(["group", "leaf", "a.txt", "b.txt", "--help"]),
    /Usage: tool group leaf/,
  );
  const ran = await parse(["group", "leaf", "a.txt", "b.txt"]);
  assert.deepEqual(ran.ran, ["leaf a.txt,b.txt"]);
});

test("a group with its own positional keeps its help", async () => {
  assertHelp(
    await parse(["positional", "anything", "--help"]),
    /Usage: tool positional/,
  );
});

test("a command with an action and subcommands runs, dispatches and guards", async () => {
  assert.deepEqual((await parse(["both"])).ran, ["both"]);
  assert.deepEqual((await parse(["both", "list"])).ran, ["both list"]);
  assertHelp(await parse(["both", "--help"]), /Usage: tool both/);
  assertHelp(await parse(["both", "list", "--help"]), /Usage: tool both list/);
  const typo = await parse(["both", "lst", "--help"]);
  assert.equal(typo.error?.code, "commander.unknownCommand");
  assert.match(typo.error?.message ?? "", /Did you mean list\?/);
});

test("the help command still works", async () => {
  // `help <name>` exits through Commander's `commander.help`, not the flag's
  // `commander.helpDisplayed`.
  const result = await parse(["help", "group"]);
  assert.equal(result.error?.code, "commander.help");
  assert.match(result.out, /Usage: tool group/);
});

test("mcpjam cloud evalz --help is a usage error, not the cloud help", async () => {
  const run = await runCli(["cloud", "evalz", "--help"]);

  assert.equal(run.exitCode, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /"code":"USAGE_ERROR"/);
  assert.match(run.stderr, /unknown command 'evalz'/);
  assert.match(run.stderr, /Did you mean one of eval, evals\?/);
});

test("mcpjam cloud evals is the eval group", async () => {
  const alias = await runCli(["cloud", "evals", "--help"]);
  const canonical = await runCli(["cloud", "eval", "--help"]);

  assert.equal(alias.exitCode, 0);
  assert.equal(alias.stdout, canonical.stdout);
  assert.match(alias.stdout, /Usage: mcpjam cloud eval\|evals/);
});

/** Answers the project and list routes and records every request path. */
async function startListFixture(): Promise<{
  baseUrl: string;
  paths: string[];
  close: () => Promise<void>;
}> {
  const paths: string[] = [];
  const server: Server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain body
    }
    const url = new URL(req.url ?? "/", "http://fixture");
    paths.push(url.pathname);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/projects") {
      res.end(
        JSON.stringify({
          items: [
            {
              id: "proj-alpha",
              name: "Alpha",
              description: null,
              icon: null,
              organizationId: "org-1",
              visibility: null,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ items: [] }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server has no address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    paths,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function runAgainst(
  baseUrl: string,
  paths: string[],
  argv: string[],
): Promise<{ exitCode: number; stdout: string; paths: string[] }> {
  paths.length = 0;
  const run = await runCli([
    ...argv,
    "--project",
    "proj-alpha",
    "--api-key",
    "sk_test",
    "--api-url",
    baseUrl,
    "--format",
    "json",
  ]);
  return { exitCode: run.exitCode, stdout: run.stdout, paths: [...paths] };
}

test("cloud evals list sends what cloud eval list sends", async () => {
  const fixture = await startListFixture();
  try {
    const canonical = await runAgainst(fixture.baseUrl, fixture.paths, [
      "cloud",
      "eval",
      "list",
    ]);
    const alias = await runAgainst(fixture.baseUrl, fixture.paths, [
      "cloud",
      "evals",
      "list",
    ]);

    assert.equal(canonical.exitCode, 0);
    assert.ok(canonical.paths.length > 0);
    assert.deepEqual(alias, canonical);
  } finally {
    await fixture.close();
  }
});

test("projects servers list is projects servers", async () => {
  const fixture = await startListFixture();
  try {
    const bare = await runAgainst(fixture.baseUrl, fixture.paths, [
      "cloud",
      "projects",
      "servers",
    ]);
    const list = await runAgainst(fixture.baseUrl, fixture.paths, [
      "cloud",
      "projects",
      "servers",
      "list",
    ]);

    assert.equal(bare.exitCode, 0);
    assert.ok(bare.paths.includes("/api/v1/projects/proj-alpha/servers"));
    assert.deepEqual(list, bare);
  } finally {
    await fixture.close();
  }
});
