import { fireEvent, render } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  PreviewServerIcon,
  PreviewServerIconSource,
} from "../PreviewServerIcon";

function icon(url: string, icons: { src: string }[], customUrl?: string) {
  return (
    <PreviewServerIconSource.Provider value={{ url, icons }}>
      <PreviewServerIcon className="size-8" customUrl={customUrl} />
    </PreviewServerIconSource.Provider>
  );
}

it("uses the declared server icon, falls back on failure, and follows server switches", () => {
  const first = "https://assets.example/team.png";
  const { container, rerender } = render(
    icon("https://one.example/mcp", [{ src: first }]),
  );
  const img = () => container.querySelector("img")!;
  expect(img()).toHaveAttribute("src", first);
  fireEvent.error(img());
  expect(img()).toHaveAttribute("src", "https://one.example/favicon.ico");
  fireEvent.error(img());
  expect(container.querySelector("svg")).toBeInTheDocument();
  rerender(icon("https://mcp.mcpjam.com/mcp", []));
  expect(img()).toHaveAttribute("src", "/mcp_jam.svg");
});

it("prefers the custom Claude listing icon, then the server icon", () => {
  const { container } = render(
    icon(
      "https://mcp.mcpjam.com/mcp",
      [{ src: "https://assets.example/server.png" }],
      "https://assets.example/listing.png",
    ),
  );
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "https://assets.example/listing.png",
  );
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "https://assets.example/server.png",
  );
});
