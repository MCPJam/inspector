import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HandDrawnSendHint } from "../HandDrawnSendHint";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("HandDrawnSendHint", () => {
  it("uses arrow-8.svg for the illustrated arrow (not arrow-3)", () => {
    const src = readFileSync(
      join(__dirname, "../HandDrawnSendHint.tsx"),
      "utf-8",
    );
    expect(src).toMatch(/from\s+["']\.\/arrow-8\.svg\?raw["']/);
    expect(src).not.toMatch(/arrow-3\.svg/);
  });

  it("renders the hint label", () => {
    render(<HandDrawnSendHint theme="light" />);
    expect(screen.getByTestId("app-builder-send-nux-hint")).toHaveTextContent(
      "Try this prompt with a demo MCP server",
    );
  });
});
