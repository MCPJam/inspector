import { describe, expect, it } from "vitest";
import {
  describeError,
  ERROR_CATALOG,
  originOf,
} from "../../src/error-describer/index.js";

function spawnError(command: string, code: string) {
  return Object.assign(new Error(`spawn ${command} ${code}`), {
    code,
    errno: -2,
    syscall: `spawn ${command}`,
    path: command,
  });
}

describe("describeError — connect phase", () => {
  it("files an unclassified connect failure under connect/unclassified", () => {
    const message = "Upstream said no in an unfamiliar way";
    const out = describeError(new Error(message), { phase: "connect" });
    expect(out.slug).toBe("connect/unclassified");
    expect(out.oneLine).toBe(message);
    expect(out.rawMessage).toBe(message);
    expect(originOf(out)).toBe("ambiguous");
  });

  it("keeps internal/unknown outside the connect phase", () => {
    expect(describeError(new Error("Upstream said no")).slug).toBe(
      "internal/unknown",
    );
  });

  it("does not override a classified connect failure", () => {
    const out = describeError(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
      phase: "connect",
    });
    expect(out.slug).toBe("transport/econnrefused");
  });

  it("keeps the catalog copy when a connect failure has no message", () => {
    const out = describeError("", { phase: "connect" });
    expect(out.slug).toBe("connect/unclassified");
    expect(out.oneLine).toBe(ERROR_CATALOG["connect/unclassified"].oneLine);
  });
});

describe("describeError — stdio spawn failures", () => {
  it.each([
    ["missing program", spawnError("npx", "ENOENT")],
    ["not executable", spawnError("./server.sh", "EACCES")],
  ])("classifies a %s as transport/spawn_failed", (_label, error) => {
    const out = describeError(error);
    expect(out.slug).toBe("transport/spawn_failed");
    expect(out.rawCode).toBe(error.code);
    expect(originOf(out)).toBe("user_config");
  });

  it("classifies the message alone after it crossed a wire", () => {
    expect(describeError(new Error("spawn uvx ENOENT")).slug).toBe(
      "transport/spawn_failed",
    );
  });

  it("classifies a message whose command path has spaces", () => {
    const message = String.raw`spawn C:\Program Files\nodejs\node.exe ENOENT`;
    expect(describeError(new Error(message)).slug).toBe(
      "transport/spawn_failed",
    );
  });

  it("rejects a long run of spaces with no errno in linear time", () => {
    const message = `spawn x${" ".repeat(100_000)}y`;
    const started = performance.now();
    expect(describeError(new Error(message)).slug).not.toBe(
      "transport/spawn_failed",
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("does not read the errno as the command", () => {
    expect(describeError(new Error("spawn ENOENT")).slug).not.toBe(
      "transport/spawn_failed",
    );
  });

  it("leaves an ENOENT from another syscall alone", () => {
    const error = Object.assign(
      new Error("ENOENT: no such file or directory, open 'config.json'"),
      { code: "ENOENT", syscall: "open" },
    );
    expect(describeError(error).slug).not.toBe("transport/spawn_failed");
  });
});
