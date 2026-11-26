/**
 * The conformance suite's Responses mock: its COUNT reply names each scenario
 * turn it can see, so a driver can tell a lost turn from a duplicated one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MOCK = fileURLToPath(new URL("../conformance/mock-responses.mjs", import.meta.url));
let mock: ChildProcess;
let port = 0;

beforeAll(async () => {
  mock = spawn(process.execPath, [MOCK], {
    env: { ...process.env, MOCK_PORT: "0", MOCK_POP_SECRET: "", MOCK_UPSTREAM_KEY: "" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [line] = await once(createInterface({ input: mock.stdout! }), "line");
  port = JSON.parse(line).port;
});

afterAll(() => {
  mock.kill();
});

const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

async function countReply(turns: string[]): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", stream: false, input: turns.map(user) }),
  });
  const body = await response.json();
  return body.output[0].content[0].text;
}

describe("the Responses mock's COUNT reply", () => {
  it("counts and lists the scenario turns, oldest first, skipping the runtime's own context", async () => {
    const turns = ["<environment>\nnot a turn", "<current_datetime>now</current_datetime>\n\nHELLO", "MCPPROBE", "COUNT"];
    expect(await countReply(turns)).toBe("USER_TURNS=3 SCENARIOS=HELLO,MCPPROBE,COUNT");
  });

  it("shows a lost turn even when a duplicated one keeps the count", async () => {
    expect(await countReply(["MCPPROBE", "MCPPROBE", "COUNT"])).toBe("USER_TURNS=3 SCENARIOS=MCPPROBE,MCPPROBE,COUNT");
  });
});
