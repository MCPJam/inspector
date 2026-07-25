import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CacheProvenanceBadge } from "@/components/ui/cache-provenance-badge";

describe("CacheProvenanceBadge", () => {
  it("renders nothing when servedFromCache is absent (no cache hit)", () => {
    const { container } = render(<CacheProvenanceBadge />);
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByTestId("cache-provenance-badge"),
    ).not.toBeInTheDocument();
  });

  it("renders the badge with a formatted age when a hit occurred", () => {
    render(<CacheProvenanceBadge servedFromCache={{ ageMs: 4200 }} />);

    const badge = screen.getByTestId("cache-provenance-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("served from client cache · 4s");
  });

  it("formats sub-second ages in milliseconds", () => {
    render(<CacheProvenanceBadge servedFromCache={{ ageMs: 250 }} />);

    expect(screen.getByTestId("cache-provenance-badge")).toHaveTextContent(
      "served from client cache · 250ms",
    );
  });
});
