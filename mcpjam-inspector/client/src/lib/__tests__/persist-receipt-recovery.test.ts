import { expect, it, vi } from "vitest";
import { createPersistReceiptRecovery } from "../persist-receipt-recovery";
import type { PersistReceiptData } from "@/shared/persist-receipt";

it("shares only in-flight saves and allows another retry after a failed save", async () => {
  const receipt: PersistReceiptData = {
    outcome: "failed", failureKind: "http_error", chatSessionId: "chat", turnId: "turn",
    retryProjectId: "project", retryHandle: "ac7bb39a-9219-40ca-802d-583951fab542",
  };
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const recover = createPersistReceiptRecovery(fetcher);
  const first = recover(receipt);
  expect(recover(receipt)).toBe(first);
  resolve(new Response(null, { status: 503 }));
  expect(await first).toEqual(receipt);
  const saved = { outcome: "saved", chatSessionId: "chat", turnId: "turn", version: 4 };
  fetcher.mockResolvedValueOnce(Response.json(saved));
  expect(await recover(receipt)).toEqual(saved);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
