import { describe, expect, it } from "vitest";
import {
  DESCRIBE_ATTACHMENT_MAX_BYTES,
  appendToDraft,
  readDescribeAttachment,
} from "../describe-attachment";

// jsdom's File has no `text()`; browsers do. Give the fixtures one.
function textFile(content: string, name: string): File {
  return Object.assign(new File([content], name), {
    text: async () => content,
  });
}

describe("readDescribeAttachment", () => {
  it("reads .txt and .md files, trimmed", async () => {
    for (const name of ["research.txt", "Research.MD", "notes.markdown"]) {
      const result = await readDescribeAttachment(
        textFile("  Maya runs payouts.\n", name),
      );
      expect(result).toEqual({ ok: true, text: "Maya runs payouts." });
    }
  });

  it("refuses other types, empty files and files over the byte cap", async () => {
    expect(
      await readDescribeAttachment(textFile("x", "research.docx")),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/\.txt and \.md/),
    });
    expect(
      await readDescribeAttachment(textFile("   ", "empty.md")),
    ).toMatchObject({ ok: false, error: "empty.md is empty." });
    expect(
      await readDescribeAttachment(
        textFile("x".repeat(DESCRIBE_ATTACHMENT_MAX_BYTES + 1), "big.txt"),
      ),
    ).toMatchObject({ ok: false, error: "big.txt is larger than 1 MB." });
  });
  it("returns an error result when the file cannot be read", async () => {
    const unreadable = Object.assign(new File(["x"], "locked.md"), {
      text: () => Promise.reject(new Error("NotReadableError")),
    });
    expect(await readDescribeAttachment(unreadable)).toEqual({
      ok: false,
      error: "locked.md could not be read.",
    });
  });
});

describe("appendToDraft", () => {
  it("fills an empty draft and appends to a typed one", () => {
    expect(appendToDraft("", "file")).toBe("file");
    expect(appendToDraft("  ", "file")).toBe("file");
    expect(appendToDraft("typed\n", "file")).toBe("typed\n\nfile");
  });
});
