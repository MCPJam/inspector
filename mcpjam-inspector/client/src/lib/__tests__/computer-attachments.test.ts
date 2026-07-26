import { describe, expect, it, vi } from "vitest";
import {
  COMPUTER_ATTACHMENTS_DIR,
  buildComputerAttachmentNote,
  uploadAttachmentsToComputer,
  zipAttachmentNoteEntries,
} from "../computer-attachments";
import type { UploadedComputerFile } from "../computer-terminal-connection";

function makeFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "text/plain" });
}

describe("buildComputerAttachmentNote", () => {
  it("returns an empty string for no entries (no stray note block)", () => {
    expect(buildComputerAttachmentNote([])).toBe("");
  });

  it("renders one line per file with the original name and sandbox path", () => {
    const note = buildComputerAttachmentNote([
      { name: "report.csv", path: "/home/user/attachments/ab12cd34-report.csv" },
      { name: "data.json", path: "/home/user/attachments/ef56gh78-data.json" },
    ]);
    expect(note).toBe(
      [
        "[Attachments uploaded to the computer — use the bash tool to read them]",
        "- report.csv: /home/user/attachments/ab12cd34-report.csv",
        "- data.json: /home/user/attachments/ef56gh78-data.json",
      ].join("\n"),
    );
  });
});

describe("zipAttachmentNoteEntries", () => {
  it("pairs original names with server paths in order", () => {
    const uploaded: UploadedComputerFile[] = [
      { name: "x1-report.csv", path: "/home/user/attachments/x1-report.csv", bytes: 3 },
      { name: "x2-data.json", path: "/home/user/attachments/x2-data.json", bytes: 3 },
    ];
    expect(zipAttachmentNoteEntries(["report.csv", "data.json"], uploaded)).toEqual([
      { name: "report.csv", path: "/home/user/attachments/x1-report.csv" },
      { name: "data.json", path: "/home/user/attachments/x2-data.json" },
    ]);
  });

  it("falls back to the server-reported name when the arrays disagree", () => {
    const uploaded: UploadedComputerFile[] = [
      { name: "x1-a.txt", path: "/home/user/attachments/x1-a.txt", bytes: 3 },
    ];
    expect(zipAttachmentNoteEntries([], uploaded)).toEqual([
      { name: "x1-a.txt", path: "/home/user/attachments/x1-a.txt" },
    ]);
  });
});

describe("uploadAttachmentsToComputer", () => {
  it("reserves BEFORE minting BEFORE uploading, targets the attachments dir, and returns note entries", async () => {
    const calls: string[] = [];
    const reserve = vi.fn(async () => {
      calls.push("reserve");
    });
    const mintToken = vi.fn(async () => {
      calls.push("mint");
      return { token: "tok-1" };
    });
    const upload = vi.fn(async (args: { token: string; dir?: string }) => {
      calls.push("upload");
      expect(args.token).toBe("tok-1");
      expect(args.dir).toBe(COMPUTER_ATTACHMENTS_DIR);
      return [
        {
          name: "x1-report.csv",
          path: "/home/user/attachments/x1-report.csv",
          bytes: 3,
        },
      ];
    });

    const entries = await uploadAttachmentsToComputer(
      { reserve, mintToken, upload: upload as never },
      { projectId: "p1", files: [makeFile("report.csv")] },
    );

    expect(calls).toEqual(["reserve", "mint", "upload"]);
    expect(reserve).toHaveBeenCalledWith({ projectId: "p1" });
    expect(mintToken).toHaveBeenCalledWith({ projectId: "p1" });
    expect(entries).toEqual([
      { name: "report.csv", path: "/home/user/attachments/x1-report.csv" },
    ]);
  });

  it("forwards the remote data-plane base URL to the upload client", async () => {
    const upload = vi.fn(async (args: { baseUrl?: string }) => {
      expect(args.baseUrl).toBe("wss://data-plane.example.com");
      return [];
    });
    await uploadAttachmentsToComputer(
      {
        reserve: async () => {},
        mintToken: async () => ({ token: "t" }),
        upload: upload as never,
      },
      {
        projectId: "p1",
        files: [makeFile("a.txt")],
        uploadBaseUrl: "wss://data-plane.example.com",
      },
    );
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("no-ops (no reserve, no mint) when there are no files", async () => {
    const reserve = vi.fn(async () => {});
    const mintToken = vi.fn(async () => ({ token: "t" }));
    const upload = vi.fn(async () => []);
    const entries = await uploadAttachmentsToComputer(
      { reserve, mintToken, upload: upload as never },
      { projectId: "p1", files: [] },
    );
    expect(entries).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("propagates a reserve failure without minting or uploading (abort-the-send contract)", async () => {
    const mintToken = vi.fn(async () => ({ token: "t" }));
    const upload = vi.fn(async () => []);
    await expect(
      uploadAttachmentsToComputer(
        {
          reserve: async () => {
            throw new Error("Daily computer start limit reached.");
          },
          mintToken,
          upload: upload as never,
        },
        { projectId: "p1", files: [makeFile("a.txt")] },
      ),
    ).rejects.toThrow(/start limit/i);
    expect(mintToken).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("propagates the server's upload error message (e.g. quota / provisioning 503s)", async () => {
    await expect(
      uploadAttachmentsToComputer(
        {
          reserve: async () => {},
          mintToken: async () => ({ token: "t" }),
          upload: (async () => {
            throw new Error(
              "Upload would exceed this computer's storage quota.",
            );
          }) as never,
        },
        { projectId: "p1", files: [makeFile("a.txt")] },
      ),
    ).rejects.toThrow(/storage quota/i);
  });
});
