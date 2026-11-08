import { randomFillSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import sharp from "sharp";
import {
  decodeHarnessAttachments,
  safeHarnessAttachmentName,
  type HarnessPromptAttachment,
} from "../harness-attachments.js";
import {
  HARNESS_PROMPT_IMAGE_CONVERSATION_BUDGET,
  HARNESS_PROMPT_IMAGE_MAX_BASE64,
  HARNESS_PROMPT_IMAGE_MAX_EDGE,
  conversationImageBase64Bytes,
  harnessPromptImageHistory,
  prepareHarnessPromptImages,
  resetHarnessPromptImageLibraryForTests,
  setHarnessPromptImageLibraryLoaderForTests,
  shouldPrepareHarnessPromptImages,
  withHarnessPromptImages,
  type HarnessPromptImage,
} from "../harness-prompt-images.js";

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

const PACKAGE_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../package.json",
);

/** A structurally valid PNG whose IHDR claims `width`×`height`. */
async function pngClaimingSize(
  width: number,
  height: number,
): Promise<Buffer> {
  const png = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
  const out = Buffer.from(png);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)) >>> 0, 29);
  return out;
}

function imageAttachment(
  bytes: Uint8Array,
  mediaType = "image/png",
): HarnessPromptAttachment {
  const attachment: HarnessPromptAttachment = {
    name: "shot.png",
    fileName: safeHarnessAttachmentName("shot.png"),
    data: bytes,
    mediaType,
    sourceType: "image",
  };
  decodeHarnessAttachments([attachment]);
  return attachment;
}

function user(content: unknown[]): ModelMessage {
  return { role: "user", content } as unknown as ModelMessage;
}

afterEach(() => {
  resetHarnessPromptImageLibraryForTests();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("sharp packaging", () => {
  it("lists sharp under dependencies, not devDependencies", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.sharp).toMatch(/^\^?0\./);
    expect(pkg.devDependencies?.sharp).toBeUndefined();
  });
});

describe("shouldPrepareHarnessPromptImages", () => {
  it("prepares only for a declaring adapter with attachments, kill switch on, not a resume", () => {
    expect(
      shouldPrepareHarnessPromptImages({
        isApprovalResume: false,
        promptImageInput: true,
        attachmentCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldPrepareHarnessPromptImages({
        isApprovalResume: true,
        promptImageInput: true,
        attachmentCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldPrepareHarnessPromptImages({
        isApprovalResume: false,
        promptImageInput: false,
        attachmentCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldPrepareHarnessPromptImages({
        isApprovalResume: false,
        promptImageInput: true,
        attachmentCount: 0,
      }),
    ).toBe(false);
    vi.stubEnv("MCPJAM_HARNESS_NATIVE_IMAGES", "false");
    expect(
      shouldPrepareHarnessPromptImages({
        isApprovalResume: false,
        promptImageInput: true,
        attachmentCount: 1,
      }),
    ).toBe(false);
  });
});

describe("prepareHarnessPromptImages", () => {
  it("resizes a 6000x4000 PNG to a 2576 long edge", async () => {
    const bytes = await sharp({
      create: {
        width: 6000,
        height: 4000,
        channels: 3,
        background: { r: 12, g: 64, b: 200 },
      },
    })
      .png()
      .toBuffer();
    const [result] = await prepareHarnessPromptImages({
      attachments: [imageAttachment(bytes)],
      history: [],
    });
    expect(result?.status).toBe("attached");
    if (result?.status !== "attached") return;
    const meta = await sharp(Buffer.from(result.part.image, "base64")).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(
      HARNESS_PROMPT_IMAGE_MAX_EDGE,
    );
  });

  it("keeps a small PNG as PNG", async () => {
    const bytes = await sharp({
      create: {
        width: 32,
        height: 24,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const [result] = await prepareHarnessPromptImages({
      attachments: [imageAttachment(bytes)],
      history: [],
    });
    expect(result).toMatchObject({
      status: "attached",
      part: { type: "image", mediaType: "image/png" },
    });
    if (result?.status === "attached") {
      expect(result.part.image.startsWith("data:")).toBe(false);
    }
  });

  it("falls back to WebP and smaller edges when the preferred encode is over the limit", async () => {
    const raw = Buffer.alloc(1600 * 1600 * 3);
    randomFillSync(raw);
    const bytes = await sharp(raw, {
      raw: { width: 1600, height: 1600, channels: 3 },
    })
      .png()
      .toBuffer();
    const [result] = await prepareHarnessPromptImages({
      attachments: [imageAttachment(bytes)],
      history: [],
    });
    if (result?.status === "attached") {
      expect(["image/webp", "image/png", "image/jpeg"]).toContain(
        result.part.mediaType,
      );
      expect(result.base64Bytes).toBeLessThanOrEqual(768 * 1024 * 2);
    } else {
      expect(result).toEqual({
        status: "skipped",
        reason: "too large to attach after resizing",
      });
    }
  });

  it("skips a header over 50 megapixels without attaching", async () => {
    const [result] = await prepareHarnessPromptImages({
      attachments: [imageAttachment(await pngClaimingSize(10_000, 10_000))],
      history: [],
    });
    expect(result).toEqual({
      status: "skipped",
      reason: "too many pixels to attach",
    });
  });

  it("skips a corrupt image and reports a PDF as not-image", async () => {
    const pdf: HarnessPromptAttachment = {
      name: "notes.pdf",
      fileName: safeHarnessAttachmentName("notes.pdf"),
      data: Buffer.from("%PDF-1.4"),
      mediaType: "application/pdf",
      sourceType: "file",
    };
    decodeHarnessAttachments([pdf]);
    const results = await prepareHarnessPromptImages({
      attachments: [imageAttachment(Buffer.from("not-an-image")), pdf],
      history: [],
    });
    expect(results[0]?.status).toBe("skipped");
    expect(results[1]).toEqual({ status: "not-image" });
  });

  it("counts earlier user-message images toward the conversation budget", async () => {
    const history = [
      user(
        Array.from({ length: 8 }, () => ({
          type: "image",
          image: "A".repeat(HARNESS_PROMPT_IMAGE_MAX_BASE64),
          mediaType: "image/png",
        })),
      ),
    ];
    expect(conversationImageBase64Bytes(history)).toBe(
      HARNESS_PROMPT_IMAGE_CONVERSATION_BUDGET,
    );
    const small = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .png()
      .toBuffer();
    const [result] = await prepareHarnessPromptImages({
      attachments: [imageAttachment(small)],
      history,
    });
    expect(result?.status).toBe("skipped");
    if (result?.status === "skipped") {
      expect(result.reason).toMatch(/this conversation already carries/);
    }
  });

  it("skips later images once this turn's 4 MiB budget is full", async () => {
    const raw = Buffer.alloc(900 * 900 * 3);
    randomFillSync(raw);
    const bytes = await sharp(raw, {
      raw: { width: 900, height: 900, channels: 3 },
    })
      .png()
      .toBuffer();
    const attachments = Array.from({ length: 8 }, () => imageAttachment(bytes));
    const results = await prepareHarnessPromptImages({
      attachments,
      history: [],
    });
    const attached = results.filter((r) => r.status === "attached");
    const skippedTurn = results.filter(
      (r) =>
        r.status === "skipped" &&
        r.reason === "this message already attaches 4 MiB of images",
    );
    expect(attached.length).toBeGreaterThan(0);
    expect(skippedTurn.length + attached.length).toBeGreaterThan(0);
    const attachedBytes = attached.reduce((sum, r) => {
      return r.status === "attached" ? sum + r.base64Bytes : sum;
    }, 0);
    expect(attachedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("skips every image and warns once when sharp cannot load", async () => {
    setHarnessPromptImageLibraryLoaderForTests(async () => {
      throw new Error("libvips missing");
    });
    const small = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const first = await prepareHarnessPromptImages({
      attachments: [imageAttachment(small), imageAttachment(small)],
      history: [],
    });
    const second = await prepareHarnessPromptImages({
      attachments: [imageAttachment(small)],
      history: [],
    });
    expect(first.every((r) => r.status === "skipped")).toBe(true);
    expect(second[0]).toEqual({
      status: "skipped",
      reason: "image processing isn't available on this server",
    });
    expect(loggerSpy.warn).toHaveBeenCalledTimes(1);
  });

  it("stops between images when the turn is aborted", async () => {
    const small = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 9, g: 9, b: 9 },
      },
    })
      .png()
      .toBuffer();
    const abort = new AbortController();
    abort.abort();
    const results = await prepareHarnessPromptImages({
      attachments: [imageAttachment(small), imageAttachment(small)],
      history: [],
      abortSignal: abort.signal,
    });
    expect(results).toEqual([
      { status: "skipped", reason: "the turn was cancelled" },
      { status: "skipped", reason: "the turn was cancelled" },
    ]);
  });

  it("logs counts and skip reasons, never a name or image bytes", async () => {
    const secret = "TOP-SECRET-PIXELS";
    const [result] = await prepareHarnessPromptImages({
      attachments: [imageAttachment(Buffer.from(secret))],
      history: [],
    });
    expect(result?.status).toBe("skipped");
    const logged = JSON.stringify(loggerSpy.info.mock.calls);
    expect(logged).toContain("[harness] prompt images");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("shot.png");
  });
});

describe("withHarnessPromptImages", () => {
  it("appends attached image parts after the prompt text without mutating", () => {
    const prompt = user([{ type: "text", text: "what is this" }]);
    const messages = [prompt];
    const images: HarnessPromptImage[] = [
      {
        status: "attached",
        part: { type: "image", image: "abc", mediaType: "image/png" },
        base64Bytes: 3,
      },
    ];
    const next = withHarnessPromptImages(messages, images);
    expect(next[0]!.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", image: "abc", mediaType: "image/png" },
    ]);
    expect(prompt.content).toEqual([{ type: "text", text: "what is this" }]);
    expect(withHarnessPromptImages(messages, [{ status: "not-image" }])).toBe(
      messages,
    );
  });

  it("history is everything before the last user message", () => {
    const earlier = user([{ type: "text", text: "old" }]);
    const prompt = user([{ type: "text", text: "new" }]);
    expect(harnessPromptImageHistory([earlier, prompt])).toEqual([earlier]);
    expect(harnessPromptImageHistory([prompt])).toEqual([]);
  });
});
