import { fireEvent } from "@testing-library/react";
import { act, renderHook, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  applyBrowserOverride,
  useScopedBrowserOverride,
  PlaygroundBrowserOverrideControl,
} from "../playground-browser-override";

it("overlays Browser only, with a real empty override and no mutation", () => {
  const base = ["bash", "browser", "web_search"];
  expect(applyBrowserOverride(base, false)).toEqual(["bash", "web_search"]);
  expect(base).toEqual(["bash", "browser", "web_search"]);
  expect(applyBrowserOverride(["browser"], false)).toEqual([]);
  expect(applyBrowserOverride(undefined, true)).toEqual(["browser"]);
  expect(applyBrowserOverride(undefined, null)).toBeUndefined();
  expect(applyBrowserOverride(base, null)).toBe(base);
});
it("drops tweaks on project/client/mode changes and does not restore them on return", () => {
  const { result, rerender, unmount } = renderHook(
    ({ scope }) => useScopedBrowserOverride(scope),
    { initialProps: { scope: "p/host/normal" } },
  );
  act(() => result.current.setOverride(true));
  expect(result.current.override).toBe(true);
  rerender({ scope: "p/host/environment" });
  expect(result.current.override).toBeNull();
  rerender({ scope: "p/host/normal" });
  expect(result.current.override).toBeNull();
  act(() => result.current.setOverride(false));
  rerender({ scope: "p/other/normal" });
  expect(result.current.override).toBeNull();
  unmount();
  expect(
    renderHook(() => useScopedBrowserOverride("p/other/normal")).result.current
      .override,
  ).toBeNull();
});
it("environment mode exposes no enablement override", () => {
  render(
    <PlaygroundBrowserOverrideControl
      override={true}
      onChange={vi.fn()}
      clientEnabled={false}
      environmentMode
    />,
  );
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(
    screen.getByText("Controlled by the environment’s client"),
  ).toBeInTheDocument();
});

it("offers an explicit enablement choice and a return to the client default", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <PlaygroundBrowserOverrideControl
      override={null}
      onChange={onChange}
      clientEnabled={false}
      environmentMode={false}
    />,
  );
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  fireEvent.click(
    screen.getByRole("option", { name: "On for this Playground" }),
  );
  expect(onChange).toHaveBeenLastCalledWith(true);
  rerender(
    <PlaygroundBrowserOverrideControl
      override={true}
      onChange={onChange}
      clientEnabled={false}
      environmentMode={false}
    />,
  );
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name: "Client default (Off)" }));
  expect(onChange).toHaveBeenLastCalledWith(null);
});
