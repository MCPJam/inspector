import { describe, expect, it } from "vitest";
import { parseCommandInput } from "../command-input";

describe("parseCommandInput", () => {
  it("keeps quoted paths and empty arguments as single arguments", () => {
    expect(
      parseCommandInput('node server.js --config "My Files/config.json" ""'),
    ).toEqual({
      command: "node",
      args: ["server.js", "--config", "My Files/config.json", ""],
    });
  });

  it("keeps escaped quotes inside double quotes", () => {
    expect(parseCommandInput('echo "say \\"hi\\""')).toEqual({
      command: "echo",
      args: ['say "hi"'],
    });
  });

  it("keeps literal backslashes in Windows paths", () => {
    expect(parseCommandInput("C:\\tools\\server.exe --stdio")).toEqual({
      command: "C:\\tools\\server.exe",
      args: ["--stdio"],
    });
  });
});
