import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import {
  serverTabFromParam,
  serverTabParam,
  serverTabSearch,
  useServerCanvasUrlState,
} from "../server-canvas-url";

describe("serverTab values", () => {
  it("maps each deep-link value to its tab and back", () => {
    const pairs = [
      ["config", "configuration"],
      ["overview", "overview"],
      ["tools", "tools-metadata"],
      ["auth", "authorization"],
      ["clients", "compatibility"],
      ["history", "history"],
    ] as const;
    for (const [param, tab] of pairs) {
      expect(serverTabFromParam(param)).toBe(tab);
      expect(serverTabParam(tab)).toBe(param);
    }
  });

  it("opens Config for no value or an unknown one", () => {
    expect(serverTabFromParam(null)).toBe("configuration");
    expect(serverTabFromParam("bogus")).toBe("configuration");
    expect(serverTabSearch("configuration")).toBe("");
    expect(serverTabSearch("history")).toBe("?serverTab=history");
  });
});

function Probe() {
  const state = useServerCanvasUrlState();
  return (
    <div>
      <span data-testid="tab">{state.tab}</span>
      <span data-testid="feature">{state.featureId ?? "none"}</span>
      <button onClick={() => state.setTab("history")}>history</button>
      <button onClick={() => state.setTab("configuration")}>config</button>
      <button onClick={() => state.setFeature("tools.list")}>feature</button>
      <button onClick={() => state.setFeature(null)}>clear</button>
    </div>
  );
}

function renderAt(url: string) {
  const router = createMemoryRouter(
    [{ path: "/servers/:serverId", element: <Probe /> }],
    { initialEntries: [url] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("useServerCanvasUrlState", () => {
  it("reads the tab and feature from the URL, as after a reload", () => {
    renderAt("/servers/srv_1?serverTab=clients&feature=mcp-apps&project=p1");
    expect(screen.getByTestId("tab")).toHaveTextContent("compatibility");
    expect(screen.getByTestId("feature")).toHaveTextContent("mcp-apps");
  });

  it("writes changes to the URL, keeps other params and supports Back", async () => {
    const router = renderAt("/servers/srv_1?project=p1");
    act(() => screen.getByText("history").click());
    expect(router.state.location.search).toBe("?project=p1&serverTab=history");
    act(() => screen.getByText("feature").click());
    expect(router.state.location.search).toBe(
      "?project=p1&serverTab=history&feature=tools.list",
    );
    expect(screen.getByTestId("feature")).toHaveTextContent("tools.list");

    await act(() => router.navigate(-1));
    expect(screen.getByTestId("feature")).toHaveTextContent("none");
    expect(screen.getByTestId("tab")).toHaveTextContent("history");
    await act(() => router.navigate(1));
    expect(screen.getByTestId("feature")).toHaveTextContent("tools.list");

    act(() => screen.getByText("config").click());
    act(() => screen.getByText("clear").click());
    expect(router.state.location.search).toBe("?project=p1");
  });
});
