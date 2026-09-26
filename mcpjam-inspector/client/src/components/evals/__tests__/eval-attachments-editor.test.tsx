import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { EvalAttachmentsEditor } from "../eval-attachments-editor";

const mockSetTestCaseAttachments = vi.fn();
const mockGetConvexAccessToken = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: (name: string) => {
    if (name === "testSuites:setTestCaseAttachments") {
      return mockSetTestCaseAttachments;
    }
    throw new Error(`Unexpected mutation: ${name}`);
  },
}));

vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://demo.convex.site",
}));

vi.mock("@/hooks/use-convex-access-token", () => ({
  useConvexAccessToken: () => mockGetConvexAccessToken,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const originalFetch = global.fetch;

function textFile(name: string, content: string): File {
  const file = new File([content], name, { type: "text/plain" });
  // jsdom's File lacks the Blob read method the editor uses.
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(content).buffer,
  });
  return file;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function renderEditor() {
  const view = render(
    <EvalAttachmentsEditor suiteId="suite_1" testCaseId="case_1" value={[]} />,
  );
  const input = view.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  return { ...view, input };
}

describe("EvalAttachmentsEditor uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConvexAccessToken.mockResolvedValue("bearer-1");
    mockSetTestCaseAttachments.mockResolvedValue(null);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the file's bytes to the upload route and registers the storage id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, storageId: "kg2_attachment" }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { input } = renderEditor();

    fireEvent.change(input, {
      target: { files: [textFile("notes.txt", "hello")] },
    });

    await waitFor(() =>
      expect(mockSetTestCaseAttachments).toHaveBeenCalledTimes(1),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://demo.convex.site/web/uploads/blob?purpose=eval-attachment&suiteId=suite_1",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "text/plain",
      Authorization: "Bearer bearer-1",
    });
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("hello");
    expect(mockSetTestCaseAttachments).toHaveBeenCalledWith({
      testCaseId: "case_1",
      attachments: [
        {
          name: "notes.txt",
          storageId: "kg2_attachment",
          // sha256("hello")
          contentHash:
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        },
      ],
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    [401, "UNAUTHORIZED", "Sign in again to upload."],
    [403, "FORBIDDEN", "You cannot edit this suite."],
    [413, "PAYLOAD_TOO_LARGE", "Attachment exceeds the size limit."],
    [429, "RATE_LIMITED", "Too many uploads. Try again shortly."],
  ])(
    "shows the route's message for a %i and registers nothing",
    async (status, code, message) => {
      global.fetch = vi.fn(async () =>
        jsonResponse(
          status,
          { ok: false, code, error: message },
          status === 429 ? { "Retry-After": "5" } : {},
        ),
      ) as unknown as typeof fetch;
      const { input } = renderEditor();

      fireEvent.change(input, {
        target: { files: [textFile("notes.txt", "hello")] },
      });

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          `Failed to attach file: ${message}`,
        ),
      );
      expect(mockSetTestCaseAttachments).not.toHaveBeenCalled();
    },
  );

  it("refuses a file over the one-attachment limit before uploading", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const big = textFile("big.bin", "x");
    Object.defineProperty(big, "size", { value: 19 * 1024 * 1024 + 1 });
    const { input } = renderEditor();

    fireEvent.change(input, { target: { files: [big] } });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        '"big.bin" is larger than the 19 MB limit for one attachment.',
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSetTestCaseAttachments).not.toHaveBeenCalled();
  });

  it("does not upload without a bearer", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    mockGetConvexAccessToken.mockResolvedValue(null);
    const { input } = renderEditor();

    fireEvent.change(input, {
      target: { files: [textFile("notes.txt", "hello")] },
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSetTestCaseAttachments).not.toHaveBeenCalled();
  });
});
