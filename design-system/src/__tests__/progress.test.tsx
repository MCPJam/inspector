// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Progress } from "../components/progress";

afterEach(cleanup);

const indicator = (container: HTMLElement) =>
  container.querySelector('[data-slot="progress-indicator"]');

it("fills with the primary role by default", () => {
  const { container } = render(<Progress value={40} />);
  expect(indicator(container)?.className).toContain("bg-primary");
  expect(indicator(container)?.className).not.toContain("duration-700");
});

it("takes a success tone and a gradual pace", () => {
  const { container } = render(
    <Progress value={40} tone="success" pace="gradual" />,
  );
  const className = indicator(container)?.className ?? "";
  expect(className).toContain("bg-success");
  expect(className).not.toContain("bg-primary");
  expect(className).toContain("duration-700");
  expect(className).toContain("motion-reduce:transition-none");
});

it("takes a slower, softer fill pace", () => {
  const { container } = render(<Progress value={40} pace="fill" />);
  const className = indicator(container)?.className ?? "";
  expect(className).toContain("duration-1000");
  expect(className).toContain("motion-reduce:transition-none");
});
