import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  prepareAccountDeletion,
  loadAccountDeletion,
  claimAccountDeletion,
  discardAccountDeletion,
  activeAccountDeletion,
  activateAccountDeletion,
} from "../account-deletion-storage";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("crypto", webcrypto);
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());
async function persisted(localId: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open("mcpjam-account-deletion-recovery", 1);
    opening.onsuccess = () => {
      const db = opening.result;
      const read = db
        .transaction("receipts")
        .objectStore("receipts")
        .get(localId);
      read.onsuccess = () => {
        resolve(read.result);
        db.close();
      };
      read.onerror = () => {
        reject(read.error);
        db.close();
      };
    };
    opening.onerror = () => reject(opening.error);
  });
}
it("uses real WebCrypto and retains only encrypted receipt credentials", async () => {
  const pending = await prepareAccountDeletion("user_a");
  expect(pending.receiptSecret).toMatch(/^[a-f0-9]{64}$/);
  const stored = await persisted(pending.localId);
  expect(stored).not.toHaveProperty("receiptSecret");
  expect(stored).not.toHaveProperty("idempotencyKey");
  expect(stored.key).toMatchObject({
    extractable: false,
    algorithm: { name: "AES-GCM" },
  });
  expect(
    new TextDecoder().decode(stored.ciphertext as ArrayBuffer),
  ).not.toContain(pending.receiptSecret);
  await expect(
    crypto.subtle.exportKey("raw", stored.key as CryptoKey),
  ).rejects.toThrow();
  expect(await loadAccountDeletion(pending.localId)).toEqual({
    ...pending,
    submittedAt: undefined,
  });
});
it("refresh preserves the same actor-bound secret/key while unrelated actors differ", async () => {
  const a = await prepareAccountDeletion("user_a");
  expect(await prepareAccountDeletion("user_a")).toEqual({
    ...a,
    submittedAt: undefined,
  });
  const b = await prepareAccountDeletion("user_b");
  expect(b.receiptSecret).not.toBe(a.receiptSecret);
  expect(b.idempotencyKey).not.toBe(a.idempotencyKey);
});
it("elects only one submitter across concurrent claims and retains recovery", async () => {
  const pending = await prepareAccountDeletion("user_a");
  const claims = await Promise.all([
    claimAccountDeletion(pending.localId),
    claimAccountDeletion(pending.localId),
  ]);
  expect(claims.sort()).toEqual([false, true]);
  expect(await claimAccountDeletion(pending.localId)).toBe(false);
  expect(await loadAccountDeletion(pending.localId)).toMatchObject({
    ...pending,
    submittedAt: expect.any(Number),
  });
});
it("simultaneous tab preparations converge on one original recovery record", async () => {
  const [a, b] = await Promise.all([
    prepareAccountDeletion("user_a"),
    prepareAccountDeletion("user_a"),
  ]);
  expect({ ...a, submittedAt: undefined }).toEqual({
    ...b,
    submittedAt: undefined,
  });
});
it("discarding a definite refusal removes its own pointer and leaves B intact", async () => {
  const a = await prepareAccountDeletion("user_a");
  const b = await prepareAccountDeletion("user_b");
  activateAccountDeletion(a.localId);
  await discardAccountDeletion(a.localId);
  expect(activeAccountDeletion()).toBeNull();
  expect(await loadAccountDeletion(a.localId)).toBeNull();
  expect(await loadAccountDeletion(b.localId)).toMatchObject(b);
});
it("blocked storage refuses before a request can be submitted", async () => {
  vi.spyOn(indexedDB, "open").mockImplementation(() => {
    throw new Error("blocked");
  });
  await expect(prepareAccountDeletion("user_a")).rejects.toThrow();
});

it("tampered ciphertext fails closed without replacing the original recovery record", async () => {
  const pending = await prepareAccountDeletion("user_a");
  const stored = await persisted(pending.localId);
  const bytes = new Uint8Array(stored.ciphertext as ArrayBuffer);
  bytes[0] ^= 1;
  await new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open("mcpjam-account-deletion-recovery", 1);
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction("receipts", "readwrite");
      transaction
        .objectStore("receipts")
        .put({ ...stored, ciphertext: bytes.buffer });
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    };
    opening.onerror = () => reject(opening.error);
  });
  await expect(loadAccountDeletion(pending.localId)).rejects.toThrow(
    "Receipt recovery could not be saved",
  );
  await expect(prepareAccountDeletion("user_a")).rejects.toThrow(
    "Receipt recovery could not be saved",
  );
  expect((await persisted(pending.localId)).localId).toBe(pending.localId);
});
