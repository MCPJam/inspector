/**
 * `SandboxImagePicker` — the shared sandbox-image control.
 *
 * The reason this file exists is the ACCESSIBILITY floor: the native `<select>`
 * this replaced was keyboard- and screen-reader-operable for free, so the
 * keyboard test below is the regression guard for the thing the redesign could
 * silently take away. It drives the control with keys only — Tab to focus,
 * Enter to open, arrows to move, Enter to commit — and asserts the same
 * `onChange` a mouse pick produces, plus the `combobox`/`listbox`/`option`
 * roles a screen reader announces.
 *
 * The option-list states (annotations, disabled drafts, the two rows that keep
 * a pin visible) are asserted against the pure `sandboxImageOptions`, which
 * needs no dropdown open — the same split `HostPicker` uses for its ordering.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SandboxImageView } from "@/hooks/useSandboxImages";
import { SandboxImagePicker, sandboxImageOptions } from "../SandboxImagePicker";

const READY = {
  environmentId: "img-ready",
  projectId: "proj-1",
  name: "Node 20",
  blueprint: "",
  contentHash: "h1",
  sharing: "project",
  isOwner: false,
  currentBuild: { buildId: "b1", status: "ready", provider: "e2b" },
  createdAt: 0,
  updatedAt: 0,
} as unknown as SandboxImageView;
const UNBUILT = {
  ...READY,
  environmentId: "img-unbuilt",
  name: "Py 3.12",
  currentBuild: null,
} as unknown as SandboxImageView;
const DRAFT = {
  ...READY,
  environmentId: "img-draft",
  name: "My draft",
  sharing: "user",
  isOwner: true,
} as unknown as SandboxImageView;

function renderPicker(
  props: Partial<React.ComponentProps<typeof SandboxImagePicker>> = {}
) {
  const onChange = vi.fn();
  render(
    <SandboxImagePicker
      variant="pill"
      images={[READY, UNBUILT, DRAFT]}
      value={null}
      onChange={onChange}
      noPinLabel="Computer · default"
      draftNote=" (draft)"
      testId="sandbox-image"
      {...props}
    />
  );
  return { onChange };
}

describe("SandboxImagePicker — keyboard operation (a11y floor)", () => {
  it("is reachable by Tab and pickable with Enter and the arrow keys alone", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.tab();
    const trigger = screen.getByTestId("sandbox-image");
    expect(trigger).toHaveFocus();
    // The role a screen reader announces, with its label and current value.
    expect(trigger).toHaveAttribute("aria-label", "Sandbox image");
    expect(trigger).toHaveTextContent("Computer · default");

    await user.keyboard("{Enter}");
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getAllByRole("option").length).toBeGreaterThan(1);

    // From the selected "no pin" row down onto the first image, then commit.
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("img-ready");
  });

  it("closes on Escape without changing the pin", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: "img-ready" });

    await user.tab();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keyboard-clears a pin back to the no-pin row", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: "img-ready" });

    await user.tab();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowUp}{Enter}");
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("skips a disabled draft row instead of committing it", async () => {
    const user = userEvent.setup();
    // Drafts last, so ArrowDown past the images lands on nothing selectable.
    const { onChange } = renderPicker({ images: [READY, DRAFT] });

    await user.tab();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("img-ready");
  });
});

describe("sandboxImageOptions — list states", () => {
  const opts = (over: Parameters<typeof sandboxImageOptions>[0]) =>
    sandboxImageOptions(over);

  it("suffixes not-built images and disables personal drafts", () => {
    expect(
      opts({
        images: [READY, UNBUILT, DRAFT],
        value: null,
        draftNote: " (draft)",
      })
    ).toEqual([
      { value: "img-ready", label: "Node 20", disabled: false },
      { value: "img-unbuilt", label: "Py 3.12 (not built)", disabled: false },
      { value: "img-draft", label: "My draft (draft)", disabled: true },
    ]);
  });

  it("disables every image — but nothing else — when images are locked", () => {
    const rows = opts({
      images: [READY, UNBUILT],
      value: null,
      draftNote: " (draft)",
      lockImages: true,
    });
    expect(rows.every((row) => row.disabled)).toBe(true);
  });

  it("labels a pin still loading rather than dropping it", () => {
    expect(
      opts({ images: undefined, value: "img-ready", draftNote: " (draft)" })
    ).toEqual([
      { value: "img-ready", label: "Loading image…", disabled: true },
    ]);
  });

  it("keeps a deleted pin visible and named once the list has settled", () => {
    expect(
      opts({ images: [READY], value: "img-gone", draftNote: " (draft)" })
    ).toContainEqual({
      value: "img-gone",
      label: "Unknown image (img-gone)",
      disabled: true,
    });
  });
});
