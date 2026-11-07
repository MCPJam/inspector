import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useRetainedFormPortal } from "../use-retained-form-portal";

function Owner({ slot, name }: { slot: HTMLElement; name: string }) {
  const portal = useRetainedFormPortal(slot);
  return portal.render(<input aria-label={name} defaultValue="retained" />);
}
afterEach(cleanup);
it("preserves focused selection and cleans up only its own portal", () => {
  const a = document.createElement("div");
  const b = document.createElement("div");
  const other = document.createElement("div");
  document.body.append(a, b, other);
  const view = render(<StrictMode><Owner slot={a} name="first" /><Owner slot={other} name="second" /></StrictMode>);
  const input = screen.getByRole("textbox", { name: "first" }) as HTMLInputElement;
  const second = screen.getByRole("textbox", { name: "second" });
  input.focus();
  input.setSelectionRange(1, 4);
  view.rerender(<StrictMode><Owner slot={b} name="first" /><Owner slot={other} name="second" /></StrictMode>);
  expect(b.querySelector("input")).toBe(input);
  expect(input).toHaveFocus();
  expect(input.selectionStart).toBe(1);
  expect(input.selectionEnd).toBe(4);
  expect(other.querySelector("input")).toBe(second);
  expect(a.children).toHaveLength(0);
  view.unmount();
  expect(b.children).toHaveLength(0);
  expect(other.children).toHaveLength(0);
  a.remove(); b.remove(); other.remove();
});

it("shows an opted-in form after the last foreign composer leaves, without a prior slot", () => {
  function Pending({ composerMounted }: { composerMounted: boolean }) {
    const portal = useRetainedFormPortal(null, !composerMounted, "workspace-X", undefined, false, !composerMounted);
    return portal.ready ? portal.render(<input aria-label="Workspace X answer" />) : null;
  }
  const view = render(<Pending composerMounted />);
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<Pending composerMounted={false} />);
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Workspace X answer" })).toBeVisible();
});
