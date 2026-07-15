import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ElicitationDialog } from "../ElicitationDialog";
import type { DialogElicitation } from "../ToolsTab";

const onResponse = vi.fn(async () => {});

const request = (over: Partial<DialogElicitation> = {}): DialogElicitation => ({
  requestId: "req-1",
  message: "Please provide your details",
  timestamp: "2024-01-01T00:00:00.000Z",
  ...over,
});

const accept = () =>
  fireEvent.click(screen.getByRole("button", { name: /accept/i }));

beforeEach(() => {
  onResponse.mockClear();
});

describe("ElicitationDialog", () => {
  it("renders nothing when there is no request", () => {
    render(
      <ElicitationDialog elicitationRequest={null} onResponse={onResponse} />
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the message and the three actions", () => {
    render(
      <ElicitationDialog
        elicitationRequest={request()}
        onResponse={onResponse}
      />
    );
    expect(screen.getByText("Please provide your details")).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /decline/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /accept/i })).toBeTruthy();
  });

  describe("labels", () => {
    it("prefers the schema title and shows the raw key as secondary text", () => {
      render(
        <ElicitationDialog
          elicitationRequest={request({
            schema: {
              properties: {
                user_email: { type: "string", title: "Email address" },
              },
            },
          })}
          onResponse={onResponse}
        />
      );
      expect(screen.getByText("Email address")).toBeTruthy();
      // The raw key stays visible — it is what the server keys on.
      expect(screen.getByText("user_email")).toBeTruthy();
    });

    it("does not duplicate the key when there is no title", () => {
      render(
        <ElicitationDialog
          elicitationRequest={request({
            schema: { properties: { nickname: { type: "string" } } },
          })}
          onResponse={onResponse}
        />
      );
      expect(screen.getAllByText("nickname")).toHaveLength(1);
    });
  });

  it("prefills values from schema defaults", () => {
    render(
      <ElicitationDialog
        elicitationRequest={request({
          schema: {
            properties: {
              name: { type: "string", default: "ada" },
              age: { type: "integer", default: 36 },
              subscribed: { type: "boolean", default: true },
            },
          },
        })}
        onResponse={onResponse}
      />
    );

    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe(
      "ada"
    );
    expect((screen.getByLabelText("age") as HTMLInputElement).value).toBe("36");
    expect(
      (screen.getByLabelText("subscribed") as HTMLInputElement).checked
    ).toBe(true);
  });

  it("maps formats to input types", () => {
    render(
      <ElicitationDialog
        elicitationRequest={request({
          schema: {
            properties: {
              mail: { type: "string", format: "email" },
              site: { type: "string", format: "uri" },
              day: { type: "string", format: "date" },
              moment: { type: "string", format: "date-time" },
              plain: { type: "string" },
            },
          },
        })}
        onResponse={onResponse}
      />
    );
    expect(screen.getByLabelText("mail").getAttribute("type")).toBe("email");
    expect(screen.getByLabelText("site").getAttribute("type")).toBe("url");
    expect(screen.getByLabelText("day").getAttribute("type")).toBe("date");
    expect(screen.getByLabelText("moment").getAttribute("type")).toBe(
      "datetime-local"
    );
    expect(screen.getByLabelText("plain").getAttribute("type")).toBe("text");
  });

  it("renders a multi-select enum as a checkbox list and sends the selection", async () => {
    render(
      <ElicitationDialog
        elicitationRequest={request({
          schema: {
            properties: {
              tags: {
                type: "array",
                items: {
                  anyOf: [
                    { const: "x", title: "Ex" },
                    { const: "y", title: "Why" },
                  ],
                },
              },
            },
          },
        })}
        onResponse={onResponse}
      />
    );

    const group = screen.getByRole("group", { name: "tags" });
    expect(group).toBeTruthy();
    // A real checkbox list, not a JSON textarea.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Ex" })).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Ex" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Why" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Ex" }));
    accept();

    await waitFor(() =>
      expect(onResponse).toHaveBeenCalledWith("accept", { tags: ["y"] })
    );
  });

  it("honors minItems on a multi-select enum", async () => {
    render(
      <ElicitationDialog
        elicitationRequest={request({
          schema: {
            properties: {
              tags: {
                type: "array",
                items: { enum: ["x", "y"] },
                minItems: 2,
              },
            },
          },
        })}
        onResponse={onResponse}
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "x" }));
    accept();

    expect(await screen.findByText("Select at least 2 options")).toBeTruthy();
    expect(onResponse).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "y" }));
    accept();
    await waitFor(() =>
      expect(onResponse).toHaveBeenCalledWith("accept", { tags: ["x", "y"] })
    );
  });

  it("uses a JSON textarea only for the nested (spec-forbidden) fallback", () => {
    render(
      <ElicitationDialog
        elicitationRequest={request({
          schema: {
            properties: { blob: { type: "object", title: "Blob" } },
          },
        })}
        onResponse={onResponse}
      />
    );
    expect(screen.getByLabelText("Blob").tagName).toBe("TEXTAREA");
    expect(screen.getByText("json")).toBeTruthy();
  });

  describe("inline validation", () => {
    it("blocks Accept on a missing required field and shows the error", async () => {
      render(
        <ElicitationDialog
          elicitationRequest={request({
            schema: {
              required: ["name"],
              properties: { name: { type: "string", title: "Name" } },
            },
          })}
          onResponse={onResponse}
        />
      );

      accept();

      expect(await screen.findByText("Name is required")).toBeTruthy();
      expect(onResponse).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText("Name"), {
        target: { value: "ada" },
      });
      // The error clears as soon as the user edits the field.
      expect(screen.queryByText("Name is required")).toBeNull();

      accept();
      await waitFor(() =>
        expect(onResponse).toHaveBeenCalledWith("accept", { name: "ada" })
      );
    });

    it("blocks Accept on constraint violations", async () => {
      render(
        <ElicitationDialog
          elicitationRequest={request({
            schema: {
              properties: {
                age: { type: "integer", minimum: 18 },
                mail: { type: "string", format: "email" },
              },
            },
          })}
          onResponse={onResponse}
        />
      );

      fireEvent.change(screen.getByLabelText("age"), {
        target: { value: "12" },
      });
      fireEvent.change(screen.getByLabelText("mail"), {
        target: { value: "nope" },
      });
      accept();

      expect(await screen.findByText("age must be at least 18")).toBeTruthy();
      expect(
        screen.getByText("mail must be a valid email address")
      ).toBeTruthy();
      expect(onResponse).not.toHaveBeenCalled();
    });

    it("renders errors with the destructive text style", async () => {
      render(
        <ElicitationDialog
          elicitationRequest={request({
            schema: {
              required: ["name"],
              properties: { name: { type: "string" } },
            },
          })}
          onResponse={onResponse}
        />
      );
      accept();
      const error = await screen.findByText("name is required");
      expect(error.className).toContain("text-destructive");
      expect(error.className).toContain("text-xs");
    });
  });

  describe("actions", () => {
    it("accepts with coerced content", async () => {
      render(
        <ElicitationDialog
          elicitationRequest={request({
            schema: {
              properties: {
                name: { type: "string" },
                age: { type: "integer" },
                subscribed: { type: "boolean" },
                optional: { type: "string" },
              },
            },
          })}
          onResponse={onResponse}
        />
      );

      fireEvent.change(screen.getByLabelText("name"), {
        target: { value: "ada" },
      });
      fireEvent.change(screen.getByLabelText("age"), {
        target: { value: "36" },
      });
      fireEvent.click(screen.getByLabelText("subscribed"));
      accept();

      await waitFor(() =>
        expect(onResponse).toHaveBeenCalledWith("accept", {
          name: "ada",
          age: 36,
          subscribed: true,
        })
      );
    });

    it("declines and cancels without parameters", async () => {
      render(
        <ElicitationDialog
          elicitationRequest={request({
            schema: {
              required: ["name"],
              properties: { name: { type: "string" } },
            },
          })}
          onResponse={onResponse}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /decline/i }));
      await waitFor(() => expect(onResponse).toHaveBeenCalledWith("decline"));

      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
      await waitFor(() => expect(onResponse).toHaveBeenCalledWith("cancel"));

      // Validation never blocks decline/cancel.
      expect(screen.queryByText("name is required")).toBeNull();
    });

    it("disables every action while loading", () => {
      render(
        <ElicitationDialog
          elicitationRequest={request()}
          onResponse={onResponse}
          loading
        />
      );
      for (const name of [/cancel/i, /decline/i, /accept/i]) {
        expect(
          (screen.getByRole("button", { name }) as HTMLButtonElement).disabled
        ).toBe(true);
      }
    });
  });

  describe("requesting-server identity (spec MUST)", () => {
    it("shows the server name with the immutable serverId alongside it", () => {
      // NOTE: the dialog content is portalled, so it lives on `baseElement`,
      // not on the render `container`.
      const { baseElement } = render(
        <ElicitationDialog
          elicitationRequest={request({
            serverId: "srv_abc123",
            serverName: "Acme Weather",
          })}
          onResponse={onResponse}
        />
      );
      expect(screen.getByText("Acme Weather")).toBeTruthy();
      // The trusted anchor stays visible even when a prettier name exists.
      expect(screen.getByText("srv_abc123")).toBeTruthy();
      expect(baseElement.textContent).toContain("is requesting information");
    });

    it("falls back to the serverId alone when there is no name", () => {
      const { baseElement } = render(
        <ElicitationDialog
          elicitationRequest={request({ serverId: "srv_abc123" })}
          onResponse={onResponse}
        />
      );
      expect(screen.getAllByText("srv_abc123")).toHaveLength(1);
      expect(baseElement.textContent).toContain("is requesting information");
    });

    it("uses the generic header when the caller supplies no identity", () => {
      const { baseElement } = render(
        <ElicitationDialog
          elicitationRequest={request()}
          onResponse={onResponse}
        />
      );
      expect(screen.getByText("Elicitation Request")).toBeTruthy();
      expect(baseElement.textContent).toContain("Elicitation Request");
      expect(baseElement.textContent).not.toContain(
        "is requesting information"
      );
    });
  });

  it("never renders clickable URLs (spec MUST)", () => {
    const { baseElement } = render(
      <ElicitationDialog
        elicitationRequest={request({
          message: "Visit https://evil.example.com to continue",
          serverName: "https://evil.example.com",
          serverId: "srv_1",
          schema: {
            properties: {
              site: {
                type: "string",
                title: "https://evil.example.com",
                description: "See https://evil.example.com/docs",
                default: "https://evil.example.com/prefilled",
                format: "uri",
              },
            },
          },
        })}
        onResponse={onResponse}
      />
    );

    // Guard the assertion itself: the portalled dialog really is in this tree.
    expect(baseElement.textContent).toContain("is requesting information");
    expect(baseElement.querySelectorAll("a")).toHaveLength(0);
    // The URL text is still shown — just never as a link.
    expect(screen.getByText("See https://evil.example.com/docs")).toBeTruthy();
  });
});
