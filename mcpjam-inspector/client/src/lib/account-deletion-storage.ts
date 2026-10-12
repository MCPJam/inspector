import { z } from "zod";
import type { AccountDeletionRecovery } from "@mcpjam/sdk/account-deletion";

export type PendingAccountDeletion = AccountDeletionRecovery & {
  localId: string;
  actorSubject: string;
  submittedAt?: number;
};
type EncryptedRecord = {
  localId: string;
  actorSubject: string;
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
  submittedAt?: number;
};
const recordSchema = z.object({
  localId: z.string().uuid(),
  actorSubject: z.string().min(1),
  receiptSecret: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().uuid(),
});
const ACTIVE_KEY = "mcpjam:account-deletion-recovery-active";
export function activeAccountDeletion(): string | null {
  try {
    const value = window.localStorage.getItem(ACTIVE_KEY);
    return value && z.string().uuid().safeParse(value).success ? value : null;
  } catch {
    return null;
  }
}
export function activateAccountDeletion(localId: string): void {
  window.localStorage.setItem(ACTIVE_KEY, localId);
}
export function clearActiveAccountDeletion(localId: string): void {
  if (activeAccountDeletion() === localId)
    window.localStorage.removeItem(ACTIVE_KEY);
}

function unavailable(): Error {
  return new Error(
    "Receipt recovery could not be saved. Allow browser storage and try again.",
  );
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(unavailable());
  });
}
function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(unavailable());
  });
}
async function database(): Promise<IDBDatabase> {
  const opening = indexedDB.open("mcpjam-account-deletion-recovery", 1);
  opening.onupgradeneeded = () => {
    const store = opening.result.createObjectStore("receipts", {
      keyPath: "localId",
    });
    store.createIndex("by_actor", "actorSubject", { unique: true });
  };
  return request(opening);
}
async function read(
  localId: string,
  byActor = false,
): Promise<EncryptedRecord | undefined> {
  const db = await database();
  try {
    const store = db
      .transaction("receipts", "readonly")
      .objectStore("receipts");
    const value: unknown = await request(
      byActor ? store.index("by_actor").get(localId) : store.get(localId),
    );
    if (value === undefined) return undefined;
    if (
      !value ||
      typeof value !== "object" ||
      !("key" in value) ||
      !("ciphertext" in value)
    )
      throw unavailable();
    return value as EncryptedRecord;
  } finally {
    db.close();
  }
}
async function decrypt(
  record: EncryptedRecord,
): Promise<PendingAccountDeletion> {
  try {
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: record.iv,
        additionalData: new TextEncoder().encode(record.localId),
      },
      record.key,
      record.ciphertext,
    );
    const parsed = recordSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (
      parsed.localId !== record.localId ||
      parsed.actorSubject !== record.actorSubject
    )
      throw unavailable();
    return { ...parsed, submittedAt: record.submittedAt };
  } catch {
    throw unavailable();
  }
}
export async function loadAccountDeletion(
  localId: string,
): Promise<PendingAccountDeletion | null> {
  const record = await read(localId);
  return record ? decrypt(record) : null;
}

/** Nonextractable keys and ciphertext remain independent of account/auth cleanup. */
export async function prepareAccountDeletion(
  actorSubject: string,
): Promise<PendingAccountDeletion> {
  const existing = await read(actorSubject, true);
  if (existing) return decrypt(existing);
  const receiptSecret = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const pending = {
    localId: crypto.randomUUID(),
    actorSubject,
    receiptSecret,
    idempotencyKey: crypto.randomUUID(),
  };
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(pending.localId),
    },
    key,
    new TextEncoder().encode(JSON.stringify(pending)),
  );
  const db = await database();
  try {
    const transaction = db.transaction("receipts", "readwrite");
    const done = completion(transaction);
    transaction
      .objectStore("receipts")
      .add({ localId: pending.localId, actorSubject, key, iv, ciphertext });
    await done;
    return pending;
  } catch {
    // Another tab can win the unique actor insertion. Its original key is the only retry key.
    const winner = await read(actorSubject, true);
    if (winner) return decrypt(winner);
    throw unavailable();
  } finally {
    db.close();
  }
}

/** A transaction elects one submitter; refresh/other tabs can only read the receipt. */
export async function claimAccountDeletion(localId: string): Promise<boolean> {
  const db = await database();
  try {
    const transaction = db.transaction("receipts", "readwrite");
    const done = completion(transaction);
    const store = transaction.objectStore("receipts");
    const record = await request<EncryptedRecord | undefined>(
      store.get(localId),
    );
    if (!record) {
      await done;
      throw unavailable();
    }
    if (record.submittedAt !== undefined) {
      await done;
      return false;
    }
    store.put({ ...record, submittedAt: Date.now() });
    await done;
    return true;
  } finally {
    db.close();
  }
}
export async function discardAccountDeletion(localId: string): Promise<void> {
  const db = await database();
  try {
    const transaction = db.transaction("receipts", "readwrite");
    const done = completion(transaction);
    transaction.objectStore("receipts").delete(localId);
    await done;
    clearActiveAccountDeletion(localId);
  } finally {
    db.close();
  }
}
