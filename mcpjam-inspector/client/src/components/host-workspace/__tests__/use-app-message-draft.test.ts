import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileAttachment } from "../../chat-v2/chat-input/attachments/file-utils";
import { appendDraftText, useAppMessageDraft } from "../use-app-message-draft";

const draft = (content: unknown[]) => ({
  instanceToken: "x".repeat(43),
  operationId: crypto.randomUUID(),
  sourceThreadId: "chat-1",
  params: {
    role: "user" as const,
    content,
    _meta: { "openai/message": { send: false } },
  },
});

function composer(input = "") {
  let attachments: FileAttachment[] = [];
  return {
    input,
    setInput: vi.fn(),
    setFileAttachments: vi.fn(
      (
        next: FileAttachment[] | ((old: FileAttachment[]) => FileAttachment[]),
      ) => {
        attachments = typeof next === "function" ? next(attachments) : next;
      },
    ),
    attachments: () => attachments,
  };
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:preview");
});

describe("an App's editable draft in the composer", () => {
  it("joins text to what the person typed and never replaces it", () => {
    expect(appendDraftText("", "Draft")).toBe("Draft");
    expect(appendDraftText("Mine  \n", "Draft")).toBe("Mine\n\nDraft");
    expect(appendDraftText("Mine", "")).toBe("Mine");
  });

  it("lands each content type in the right place", async () => {
    const c = composer("Already typed");
    const view = renderHook(() => useAppMessageDraft("chat-1", c));
    await act(async () => {
      expect(
        await view.result.current.place(
          draft([
            { type: "text", text: "Help me design a bracket." },
            { type: "image", mimeType: "image/png", data: "AQID" },
            {
              type: "text",
              text: "Spec",
              _meta: { "openai/title": "Bracket spec" },
            },
            {
              type: "resource_link",
              uri: "file:///synthetic/part",
              name: "part.stl",
            },
            {
              type: "resource",
              resource: { uri: "fixture://notes", text: "embedded" },
            },
          ]),
        ),
      ).toBe(true);
    });
    expect(c.setInput).toHaveBeenCalledWith(
      "Already typed\n\nHelp me design a bracket.",
    );
    expect(c.attachments()).toHaveLength(1);
    expect(c.attachments()[0].file.type).toBe("image/png");
    expect(
      view.result.current.contextAttachments.map((item) => item.title),
    ).toEqual(["Bracket spec", "part.stl", "fixture://notes"]);
    expect(view.result.current.parts).toEqual([
      {
        type: "data-plugin-message-text",
        data: { title: "Bracket spec", text: "Spec" },
      },
      expect.objectContaining({ type: "text" }),
      { type: "text", text: "embedded" },
    ]);
  });

  it("keeps items until they are sent or discarded, and only in their own chat", async () => {
    const c = composer();
    const view = renderHook((key: string) => useAppMessageDraft(key, c), {
      initialProps: "chat-1",
    });
    const item = {
      type: "text",
      text: "Spec",
      _meta: { "openai/title": "Bracket spec" },
    };
    await act(async () => {
      await view.result.current.place(draft([item]));
    });
    view.rerender("chat-1");
    expect(view.result.current.items).toHaveLength(1);
    view.rerender("chat-2");
    expect(view.result.current.items).toHaveLength(0);
    view.rerender("chat-1");
    act(() => view.result.current.contextAttachments[0].remove?.());
    expect(view.result.current.items).toHaveLength(0);
    await act(async () => {
      await view.result.current.place(draft([item, item]));
    });
    act(() => view.result.current.clear());
    expect(view.result.current.items).toHaveLength(0);
  });

  it("refuses a draft past the item limit without changing anything", async () => {
    const c = composer();
    const view = renderHook(() => useAppMessageDraft("chat-1", c));
    const item = { type: "text", text: "x", _meta: { "openai/title": "T" } };
    await act(async () => {
      await view.result.current.place(
        draft(Array.from({ length: 64 }, () => item)),
      );
    });
    await act(async () => {
      expect(
        await view.result.current.place(
          draft([{ type: "text", text: "more" }, item]),
        ),
      ).toBe(false);
    });
    expect(c.setInput).not.toHaveBeenCalled();
    expect(view.result.current.items).toHaveLength(64);
  });
});
