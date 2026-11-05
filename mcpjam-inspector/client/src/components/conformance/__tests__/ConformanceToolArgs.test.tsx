import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConformanceToolArgs } from "../ConformanceToolArgs";

const schema = {
  type: "object",
  properties: {
    message: { type: "string", description: "Text to log." },
    count: { type: "integer" },
  },
  required: ["message"],
};

function Editor({
  initial = {},
  inputSchema = schema as Record<string, unknown> | null,
  invalid = vi.fn(),
}: {
  initial?: Record<string, unknown>;
  /** `null`: the tool has no schema at all. */
  inputSchema?: Record<string, unknown> | null;
  invalid?: (invalid: boolean) => void;
}) {
  const [args, setArgs] = useState(initial);
  return (
    <>
      <ConformanceToolArgs
        inputSchema={inputSchema ?? undefined}
        argProperties={inputSchema?.properties as Record<string, unknown>}
        value={args}
        onChange={setArgs}
        onInvalidChange={invalid}
      />
      <output>{JSON.stringify(args)}</output>
    </>
  );
}
const sent = () => JSON.parse(screen.getByRole("status").textContent ?? "{}");

it("shows one field per listed argument and sends what is filled in", () => {
  render(<Editor />);
  expect(screen.getByText("message")).toBeInTheDocument();
  expect(screen.getByText("Text to log.")).toBeInTheDocument();
  expect(screen.getByText("required")).toBeInTheDocument();
  expect(screen.queryByRole("switch")).toBeNull();

  const [message, count] = screen.getAllByRole("textbox").concat(
    screen.queryAllByRole("spinbutton"),
  );
  fireEvent.change(message!, { target: { value: "hi" } });
  expect(sent()).toEqual({ message: "hi" });
  expect(count).toBeDefined();
});

it("starts from saved arguments", () => {
  render(<Editor initial={{ message: "saved" }} />);
  fireEvent.change(screen.getByDisplayValue("saved"), {
    target: { value: "new" },
  });
  expect(sent()).toEqual({ message: "new" });
});

it("keeps the free-form editor while a saved argument has no field, so it can be removed", () => {
  render(<Editor initial={{ message: "saved", extra: 1 }} />);
  expect(screen.getByRole("switch")).toBeInTheDocument();
  expect(screen.queryByText("required")).toBeNull();
  expect(sent()).toEqual({ message: "saved", extra: 1 });
});

it("shows nothing to fill in for a tool that takes no arguments", () => {
  const { container } = render(<Editor inputSchema={{ type: "object" }} />);
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add argument" })).toBeNull();
  expect(container.querySelector("textarea, input")).toBeNull();
});

it("keeps saved arguments visible for a tool that takes none, so they can be removed", () => {
  render(<Editor inputSchema={{ type: "object" }} initial={{ arg: "" }} />);
  expect(screen.getByRole("switch")).toBeInTheDocument();
});

it("keeps the free-form editor when the tool has no schema", () => {
  render(<Editor inputSchema={null} />);
  expect(screen.getByRole("switch")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Add argument" }),
  ).toBeInTheDocument();
});

it("reports a JSON box that does not parse, and sends nothing from it", () => {
  const invalid = vi.fn();
  render(
    <Editor
      invalid={invalid}
      inputSchema={{
        type: "object",
        properties: { filter: { type: "object" } },
        required: ["filter"],
      }}
    />,
  );
  const box = screen.getByPlaceholderText("Enter object as JSON");
  fireEvent.change(box, { target: { value: "{" } });
  expect(invalid).toHaveBeenLastCalledWith(true);
  expect(sent()).toEqual({});
  fireEvent.change(box, { target: { value: '{"a":1}' } });
  expect(invalid).toHaveBeenLastCalledWith(false);
  expect(sent()).toEqual({ filter: { a: 1 } });
});

it("leaves an emptied required box out", () => {
  render(<Editor initial={{ message: "hi" }} />);
  fireEvent.change(screen.getByDisplayValue("hi"), { target: { value: "" } });
  expect(sent()).toEqual({});
});

it("does not block on an emptied optional JSON box", () => {
  const invalid = vi.fn();
  render(
    <Editor
      invalid={invalid}
      inputSchema={{ type: "object", properties: { filter: { type: "object" } } }}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "skip" }));
  const box = screen.getByPlaceholderText("Enter object as JSON");
  fireEvent.change(box, { target: { value: "{" } });
  expect(invalid).toHaveBeenLastCalledWith(true);
  fireEvent.change(box, { target: { value: "" } });
  expect(invalid).toHaveBeenLastCalledWith(false);
  expect(sent()).toEqual({});
});

it("reports malformed JSON in the free-form editor", () => {
  const invalid = vi.fn();
  // A saved argument with no field keeps the free-form editor.
  render(<Editor invalid={invalid} initial={{ a: 1 }} />);
  const raw = screen.queryByRole("textbox", { name: "Arguments" });
  if (!raw) fireEvent.click(screen.getByRole("switch"));
  fireEvent.change(screen.getByRole("textbox", { name: "Arguments" }), {
    target: { value: "[1]" },
  });
  expect(invalid).toHaveBeenLastCalledWith(true);
});
