import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const loggerSpy = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../logger.js", () => ({ logger: loggerSpy }));

vi.mock("../../computers/control-plane-client.js", () => ({
  reserveUploadBytes: vi.fn(async () => ({ ok: true, value: {} })),
}));

import {
  HARNESS_ATTACHMENTS_MAX_FILES,
  HOSTED_HARNESS_ATTACHMENTS_DIR,
  buildHarnessAttachmentNote,
  computerQuotaReserver,
  safeHarnessAttachmentName,
  saveHarnessAttachments,
  takeHarnessPromptAttachments,
  unsavedHarnessAttachments,
  withHarnessAttachmentNote,
  type HarnessPromptAttachment,
} from "../harness-attachments";
import { reserveUploadBytes } from "../../computers/control-plane-client.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function dataUrl(text: string, mediaType = "text/plain"): string {
  return `data:${mediaType};base64,${Buffer.from(text).toString("base64")}`;
}

function filePart(filename: string, text: string, mediaType = "text/plain") {
  return { type: "file", mediaType, filename, data: dataUrl(text, mediaType) };
}

function userMessage(content: unknown[]): ModelMessage {
  return { role: "user", content } as unknown as ModelMessage;
}

function attachment(name: string, data: unknown): HarnessPromptAttachment {
  return { name, fileName: safeHarnessAttachmentName(name), data };
}

function fakeSession() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    writeBinaryFile: vi.fn(
      async (args: { path: string; content: Uint8Array }) => {
        files.set(args.path, args.content);
      },
    ),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("takeHarnessPromptAttachments", () => {
  it("takes file parts out of the LAST user message into a new array, leaving the input untouched", () => {
    const earlier = userMessage([
      { type: "text", text: "old" },
      filePart("old.csv", "a,b"),
    ]);
    const prompt = userMessage([
      { type: "text", text: "summarize this" },
      filePart("report.csv", "x,y\n1,2"),
    ]);
    const messages = [
      earlier,
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      } as ModelMessage,
      prompt,
    ];
    const before = structuredClone(messages);

    const taken = takeHarnessPromptAttachments(messages);

    expect(taken.messages).not.toBe(messages);
    expect(taken.messages[2]!.content).toEqual([
      { type: "text", text: "summarize this" },
    ]);
    // Only the prompt is rewritten: the harness never reads earlier turns.
    expect(taken.messages[0]).toBe(earlier);
    expect(taken.attachments).toHaveLength(1);
    expect(taken.attachments[0]!.name).toBe("report.csv");
    expect(taken.attachments[0]!.fileName).toMatch(
      new RegExp(`^${UUID}-report\\.csv$`),
    );
    // Shared with messageHistory, which persists what the user sent.
    expect(messages).toEqual(before);
    expect(prompt.content).toHaveLength(2);
  });

  it("takes image parts too, and drops any other non-text part", () => {
    const taken = takeHarnessPromptAttachments([
      userMessage([
        { type: "image", image: "aGk=", mediaType: "image/png" },
        { type: "reasoning", text: "?" },
        { type: "text", text: "what is this" },
      ]),
    ]);
    expect(taken.messages[0]!.content).toEqual([
      { type: "text", text: "what is this" },
    ]);
    expect(taken.attachments.map((a) => a.name)).toEqual(["attachment-1.png"]);
  });

  it("returns the same array when there is nothing to take", () => {
    const textOnly = [userMessage([{ type: "text", text: "hi" }])];
    expect(takeHarnessPromptAttachments(textOnly).messages).toBe(textOnly);
    const plain = [{ role: "user", content: "hi" } as ModelMessage];
    expect(takeHarnessPromptAttachments(plain)).toEqual({
      messages: plain,
      attachments: [],
    });
  });

  it("sanitizes hostile filenames: basename only, no control chars, no dot names", () => {
    const taken = takeHarnessPromptAttachments([
      userMessage([
        filePart("../../../etc/passwd", "x"),
        filePart("/home/user/.ssh/id_rsa", "x"),
        filePart("C:\\Users\\me\\evil.txt", "x"),
        filePart("bad\nname\u0007\u009b.txt", "x"),
        filePart("..", "x", "application/pdf"),
        filePart("", "x", "text/csv"),
        filePart("...hidden", "x"),
        filePart("a;rm -rf $(id).sh", "x"),
      ]),
    ]);
    const names = taken.attachments.map((a) => a.name);
    expect(names).toEqual([
      "passwd",
      "id_rsa",
      "evil.txt",
      "badname.txt",
      "attachment-5.pdf",
      "attachment-6.csv",
      "...hidden",
      "a;rm -rf $(id).sh",
    ]);
    const files = taken.attachments.map((a) => a.fileName);
    for (const file of files) {
      // One path segment, behind a uuid: nothing to traverse, nothing hidden.
      expect(file).toMatch(new RegExp(`^${UUID}-[\\w.\\- ]+$`));
      expect(file).not.toContain("/");
      expect(file).not.toContain("\\");
    }
    expect(files[0]).toMatch(new RegExp(`^${UUID}-passwd$`));
    expect(files[4]).toMatch(new RegExp(`^${UUID}-attachment-5\\.pdf$`));
    for (const bare of ["..", ".", "", "///", "\u0000"]) {
      expect(safeHarnessAttachmentName(bare)).toMatch(
        new RegExp(`^${UUID}-file$`),
      );
    }
    expect(files[6]).toMatch(new RegExp(`^${UUID}-\\.\\.\\.hidden$`));
    expect(files[7]).toMatch(new RegExp(`^${UUID}-a_rm -rf __id_\\.sh$`));
  });

  it("keeps the extension when it shortens a long name", () => {
    const name = `${"x".repeat(300)}.pdf`;
    const file = safeHarnessAttachmentName(name);
    expect(file.endsWith(".pdf")).toBe(true);
    expect(file.length).toBeLessThanOrEqual(36 + 1 + 120);
  });
});

describe("saveHarnessAttachments", () => {
  it("writes each file under the dir with its uuid name and returns the agent path", async () => {
    const session = fakeSession();
    const report = attachment("report.csv", dataUrl("x,y\n1,2"));

    const outcomes = await saveHarnessAttachments({
      session,
      dir: HOSTED_HARNESS_ATTACHMENTS_DIR,
      attachments: [report],
    });

    const path = `/home/user/attachments/${report.fileName}`;
    expect(outcomes).toEqual([{ name: "report.csv", path }]);
    expect(Buffer.from(session.files.get(path)!).toString()).toBe("x,y\n1,2");
  });

  it("writes through one spelling and names the other to the agent", async () => {
    const session = fakeSession();
    const file = attachment("a.txt", dataUrl("hi"));
    const outcomes = await saveHarnessAttachments({
      session,
      dir: "/c/Users/me/state/attachments",
      agentDir: "C:\\Users\\me\\state\\attachments",
      attachments: [file],
    });
    expect([...session.files.keys()]).toEqual([
      `/c/Users/me/state/attachments/${file.fileName}`,
    ]);
    expect(outcomes).toEqual([
      {
        name: "a.txt",
        path: `C:\\Users\\me\\state\\attachments\\${file.fileName}`,
      },
    ]);
  });

  it("decodes raw base64, bytes and AI SDK 7 tagged data", async () => {
    const session = fakeSession();
    const outcomes = await saveHarnessAttachments({
      session,
      dir: "/d",
      attachments: [
        attachment("a.txt", Buffer.from("one").toString("base64")),
        attachment("b.txt", new TextEncoder().encode("two")),
        attachment("c.txt", { type: "data", data: dataUrl("three") }),
        attachment("d.txt", new URL(dataUrl("four"))),
        attachment("e.txt", "data:text/plain,five%20six"),
      ],
    });
    expect(outcomes.every((o) => "path" in o)).toBe(true);
    expect(
      [...session.files.values()].map((b) => Buffer.from(b).toString()),
    ).toEqual(["one", "two", "three", "four", "five six"]);
  });

  it("never fetches a link; it reports it instead", async () => {
    const session = fakeSession();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const outcomes = await saveHarnessAttachments({
      session,
      dir: "/d",
      attachments: [
        attachment("remote.pdf", "https://example.com/x.pdf"),
        attachment("tagged.pdf", {
          type: "url",
          url: new URL("https://e.com/y"),
        }),
      ],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(session.writeBinaryFile).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      {
        name: "remote.pdf",
        error: "it was sent as a link, not as file content",
      },
      {
        name: "tagged.pdf",
        error: "it was sent as a link, not as file content",
      },
    ]);
    fetchSpy.mockRestore();
  });

  it("caps the file count", async () => {
    const session = fakeSession();
    const many = Array.from(
      { length: HARNESS_ATTACHMENTS_MAX_FILES + 2 },
      (_, i) => attachment(`f${i}.txt`, dataUrl(`${i}`)),
    );
    const outcomes = await saveHarnessAttachments({
      session,
      dir: "/d",
      attachments: many,
    });
    expect(session.writeBinaryFile).toHaveBeenCalledTimes(
      HARNESS_ATTACHMENTS_MAX_FILES,
    );
    expect(outcomes.slice(-2)).toEqual([
      { name: "f20.txt", error: "over the 20-file limit" },
      { name: "f21.txt", error: "over the 20-file limit" },
    ]);
  });

  it("caps each file and the total, refusing an oversized base64 string before decoding it", async () => {
    const session = fakeSession();
    const MB = 1024 * 1024;
    const outcomes = await saveHarnessAttachments({
      session,
      dir: "/d",
      attachments: [
        attachment("huge.bin", new Uint8Array(26 * MB)),
        attachment(
          "huge.b64",
          `data:application/octet-stream;base64,${"A".repeat(36 * MB)}`,
        ),
        attachment("first.bin", new Uint8Array(20 * MB)),
        attachment("second.bin", new Uint8Array(11 * MB)),
        attachment("small.bin", new Uint8Array(1 * MB)),
      ],
    });
    expect(outcomes.map((o) => ("error" in o ? o.error : "saved"))).toEqual([
      "over the 25 MB per-file limit",
      "over the 25 MB per-file limit",
      "saved",
      "over the 30 MB total limit",
      "saved",
    ]);
    expect(session.writeBinaryFile).toHaveBeenCalledTimes(2);
  });

  it("reports a failed write instead of throwing, and logs no contents", async () => {
    const secret = "TOP-SECRET-CONTENTS";
    const session = {
      writeBinaryFile: vi.fn(async () => {
        throw new Error("EACCES: permission denied");
      }),
    };
    const outcomes = await saveHarnessAttachments({
      session,
      dir: "/d",
      attachments: [attachment("secret.txt", dataUrl(secret))],
    });
    expect(outcomes).toEqual([
      { name: "secret.txt", error: "the write failed" },
    ]);
    const logged = JSON.stringify([
      ...loggerSpy.info.mock.calls,
      ...loggerSpy.warn.mock.calls,
      ...loggerSpy.error.mock.calls,
      ...loggerSpy.debug.mock.calls,
    ]);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(Buffer.from(secret).toString("base64"));
  });

  it("charges a persistent computer's quota first, and skips a file over it", async () => {
    const session = fakeSession();
    const reserveBytes = vi
      .fn<(bytes: number) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const outcomes = await saveHarnessAttachments({
      session,
      dir: "/d",
      attachments: [
        attachment("a.txt", dataUrl("12345")),
        attachment("b.txt", dataUrl("1")),
      ],
      reserveBytes,
    });
    expect(reserveBytes).toHaveBeenNthCalledWith(1, 5);
    expect(outcomes[1]).toEqual({
      name: "b.txt",
      error: "over this computer's storage quota",
    });
    expect(session.writeBinaryFile).toHaveBeenCalledTimes(1);
  });
});

describe("computerQuotaReserver", () => {
  it("refuses only on a 413", async () => {
    const reserve = computerQuotaReserver("computer-1");
    vi.mocked(reserveUploadBytes).mockResolvedValueOnce({
      ok: false,
      status: 413,
      error: "quota",
    } as never);
    expect(await reserve(10)).toBe(false);
    vi.mocked(reserveUploadBytes).mockResolvedValueOnce({
      ok: false,
      status: 0,
      error: "no token",
    } as never);
    expect(await reserve(10)).toBe(true);
    expect(reserveUploadBytes).toHaveBeenCalledWith({
      computerId: "computer-1",
      bytes: 10,
    });
  });
});

describe("the note", () => {
  it("lists saved paths and names the ones that couldn't be saved", () => {
    expect(
      buildHarnessAttachmentNote([
        { name: "report.csv", path: "/home/user/attachments/u-report.csv" },
        { name: "big.pdf", error: "over the 30 MB total limit" },
      ]),
    ).toBe(
      [
        "[Attachments uploaded to the computer: use your file tools to read them]",
        "- report.csv: /home/user/attachments/u-report.csv",
        "- big.pdf: couldn't be saved (over the 30 MB total limit)",
      ].join("\n"),
    );
  });

  it("says so when nothing was saved, and is empty with no attachments", () => {
    expect(
      buildHarnessAttachmentNote(
        unsavedHarnessAttachments([attachment("a.txt", "")]),
      ),
    ).toBe(
      [
        "[Attachments the user sent that couldn't be saved to the computer]",
        "- a.txt: couldn't be saved (the session never started)",
      ].join("\n"),
    );
    expect(buildHarnessAttachmentNote([])).toBe("");
  });

  it("rides as one more text part on the last user message, without mutating", () => {
    const prompt = userMessage([{ type: "text", text: "summarize" }]);
    const messages = [prompt];
    const next = withHarnessAttachmentNote(messages, "NOTE");
    expect(next[0]!.content).toEqual([
      { type: "text", text: "summarize" },
      { type: "text", text: "NOTE" },
    ]);
    expect(prompt.content).toHaveLength(1);
    expect(withHarnessAttachmentNote(messages, "")).toBe(messages);
    expect(
      withHarnessAttachmentNote(
        [{ role: "user", content: "hi" } as ModelMessage],
        "NOTE",
      )[0]!.content,
    ).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "NOTE" },
    ]);
  });
});
