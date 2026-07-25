import { describe, it, expect, vi } from "vitest";
import {
  seedAttachmentsIntoSandbox,
  buildAttachmentsNote,
  seedEvalCaseAttachments,
} from "../eval-attachments-seed";
import type { ResolvedEvalAttachment } from "../control-plane-client";

function att(
  over: Partial<ResolvedEvalAttachment> = {}
): ResolvedEvalAttachment {
  return {
    name: "data.csv",
    path: "/home/user/attachments/hashV1-data.csv",
    contentHash: "hashV1",
    size: 7,
    url: "https://convex.example/blob/hashV1",
    ...over,
  };
}

function okFetch(body = "seed me"): typeof fetch {
  return vi.fn(
    async () => new Response(new TextEncoder().encode(body), { status: 200 })
  ) as unknown as typeof fetch;
}

describe("seedAttachmentsIntoSandbox", () => {
  it("downloads each pinned blob and writes it to its frozen path", async () => {
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const writer = vi.fn(async ({ files }) => {
      writes.push(...files);
    });
    await seedAttachmentsIntoSandbox({
      sandboxId: "sbx_1",
      attachments: [
        att({ name: "a.csv", path: "/home/user/attachments/a.csv" }),
      ],
      writer,
      fetchImpl: okFetch("col1\n1\n2"),
    });
    expect(writer).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/home/user/attachments/a.csv");
    expect(new TextDecoder().decode(writes[0].bytes)).toBe("col1\n1\n2");
  });

  it("no-ops for an empty attachment list (no writer call)", async () => {
    const writer = vi.fn(async () => {});
    await seedAttachmentsIntoSandbox({
      sandboxId: "sbx_1",
      attachments: [],
      writer,
      fetchImpl: okFetch(),
    });
    expect(writer).not.toHaveBeenCalled();
  });

  it("FAILS HONESTLY when a pin is gone (url null) — never writes", async () => {
    const writer = vi.fn(async () => {});
    await expect(
      seedAttachmentsIntoSandbox({
        sandboxId: "sbx_1",
        attachments: [att({ url: null })],
        writer,
        fetchImpl: okFetch(),
      })
    ).rejects.toThrow(/no longer available/i);
    expect(writer).not.toHaveBeenCalled();
  });

  it("FAILS HONESTLY on a download error (non-2xx) — never writes", async () => {
    const writer = vi.fn(async () => {});
    const badFetch = vi.fn(
      async () => new Response("nope", { status: 404 })
    ) as unknown as typeof fetch;
    await expect(
      seedAttachmentsIntoSandbox({
        sandboxId: "sbx_1",
        attachments: [att()],
        writer,
        fetchImpl: badFetch,
      })
    ).rejects.toThrow(/Failed to download/i);
    expect(writer).not.toHaveBeenCalled();
  });

  it("rejects over the per-case count cap", async () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      att({ name: `f${i}.txt`, contentHash: `h${i}` })
    );
    await expect(
      seedAttachmentsIntoSandbox({
        sandboxId: "sbx_1",
        attachments: many,
        writer: vi.fn(async () => {}),
        fetchImpl: okFetch(),
      })
    ).rejects.toThrow(/limit of 20/i);
  });

  it("rejects over the per-case total-size cap", async () => {
    await expect(
      seedAttachmentsIntoSandbox({
        sandboxId: "sbx_1",
        attachments: [att({ size: 31 * 1024 * 1024 })],
        writer: vi.fn(async () => {}),
        fetchImpl: okFetch(),
      })
    ).rejects.toThrow(/MB per-case limit/i);
  });
});

describe("buildAttachmentsNote", () => {
  it("formats the COMP-14 note (name → path per line)", () => {
    const note = buildAttachmentsNote([
      att({ name: "a.csv", path: "/home/user/attachments/a.csv" }),
      att({ name: "b.txt", path: "/home/user/attachments/b.txt" }),
    ]);
    expect(note).toBe(
      "[Attachments uploaded to the computer — use the bash tool to read them]\n" +
        "- a.csv: /home/user/attachments/a.csv\n" +
        "- b.txt: /home/user/attachments/b.txt"
    );
  });

  it("returns null when there are no attachments", () => {
    expect(buildAttachmentsNote([])).toBeNull();
  });
});

describe("seedEvalCaseAttachments", () => {
  it("matches the iteration's case by testCaseId, seeds it, returns the note", async () => {
    const writer = vi.fn(async () => {});
    const resolver = vi.fn(async () => ({
      ok: true as const,
      value: {
        cases: [
          { testCaseId: "case_A", attachments: [att({ name: "a.csv" })] },
          { testCaseId: "case_B", attachments: [] },
        ],
      },
    }));
    const { note } = await seedEvalCaseAttachments({
      bearer: "tok",
      runId: "run_1",
      testCaseId: "case_A",
      sandboxId: "sbx_1",
      resolver: resolver as any,
      writer,
      fetchImpl: okFetch(),
    });
    expect(writer).toHaveBeenCalledOnce();
    expect(note).toContain("a.csv");
  });

  it("returns note:null (no seed) for a case with no attachments", async () => {
    const writer = vi.fn(async () => {});
    const resolver = vi.fn(async () => ({
      ok: true as const,
      value: { cases: [{ testCaseId: "case_A", attachments: [] }] },
    }));
    const { note } = await seedEvalCaseAttachments({
      bearer: "tok",
      runId: "run_1",
      testCaseId: "case_A",
      sandboxId: "sbx_1",
      resolver: resolver as any,
      writer,
      fetchImpl: okFetch(),
    });
    expect(note).toBeNull();
    expect(writer).not.toHaveBeenCalled();
  });

  it("throws when the run's attachments cannot be resolved", async () => {
    const resolver = vi.fn(async () => ({
      ok: false as const,
      status: 500,
      error: "boom",
    }));
    await expect(
      seedEvalCaseAttachments({
        bearer: "tok",
        runId: "run_1",
        testCaseId: "case_A",
        sandboxId: "sbx_1",
        resolver: resolver as any,
        writer: vi.fn(async () => {}),
        fetchImpl: okFetch(),
      })
    ).rejects.toThrow(/Could not resolve/i);
  });

  it("propagates a fail-honest seed error (pin gone) from the matched case", async () => {
    const writer = vi.fn(async () => {});
    const resolver = vi.fn(async () => ({
      ok: true as const,
      value: {
        cases: [{ testCaseId: "case_A", attachments: [att({ url: null })] }],
      },
    }));
    await expect(
      seedEvalCaseAttachments({
        bearer: "tok",
        runId: "run_1",
        testCaseId: "case_A",
        sandboxId: "sbx_1",
        resolver: resolver as any,
        writer,
        fetchImpl: okFetch(),
      })
    ).rejects.toThrow(/no longer available/i);
    expect(writer).not.toHaveBeenCalled();
  });
});
