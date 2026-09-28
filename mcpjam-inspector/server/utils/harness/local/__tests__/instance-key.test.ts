import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  instanceKeyFingerprint,
  leaseJti,
  loadLocalInstanceKey,
  resetInstanceKeyCacheForTests,
  setInstanceKeyStore,
  signProxiedRequest,
  type InstanceKeyStore,
} from "../instance-key.js";
import { localHarnessStateRoot } from "../grants.js";

let home: string;
let realHome: string | undefined;

function keyPath(): string {
  return join(localHarnessStateRoot(), "instance-key.json");
}

async function readStored(): Promise<{
  protection: string;
  privateKey: string;
  publicKey: string;
}> {
  return JSON.parse(await readFile(keyPath(), "utf8"));
}

/** A keystore that is available and reversible, so both halves can be driven. */
function fakeKeystore(available = true): InstanceKeyStore {
  return {
    isAvailable: () => available,
    encrypt: (plaintext) => `sealed:${Buffer.from(plaintext).toString("base64")}`,
    decrypt: (ciphertext) => {
      if (!ciphertext.startsWith("sealed:")) throw new Error("not ours");
      return Buffer.from(ciphertext.slice(7), "base64").toString("utf8");
    },
  };
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-instance-key-")));
  realHome = process.env.HOME;
  process.env.HOME = home;
  setInstanceKeyStore(null);
  resetInstanceKeyCacheForTests();
});

afterEach(async () => {
  setInstanceKeyStore(null);
  resetInstanceKeyCacheForTests();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

describe("minting the machine's instance key", () => {
  it("writes it owner-only, because it is a private key in a home directory", async () => {
    const key = await loadLocalInstanceKey();
    expect(key.publicKey.length).toBeGreaterThan(20);
    const mode = (await stat(keyPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reuses the key it already wrote, rather than rotating every start", async () => {
    const first = await loadLocalInstanceKey();
    const bytesBefore = await readFile(keyPath(), "utf8");
    resetInstanceKeyCacheForTests();
    const second = await loadLocalInstanceKey();
    expect(second.publicKey).toBe(first.publicKey);
    expect(await readFile(keyPath(), "utf8")).toBe(bytesBefore);
  });

  it("seals the private half when the OS keystore is available", async () => {
    setInstanceKeyStore(fakeKeystore());
    await loadLocalInstanceKey();
    const stored = await readStored();
    expect(stored.protection).toBe("os-keystore");
    expect(stored.privateKey).toMatch(/^sealed:/);
    // The PEM must not be sitting in the file beside its sealed form.
    expect(stored.privateKey).not.toContain("PRIVATE KEY");
  });

  it("repairs a key file whose mode drifted wider than owner-only", async () => {
    // A file written before this rule existed keeps its old mode forever:
    // `writeFile`'s `mode` applies at CREATION only, so nothing re-narrows it.
    await loadLocalInstanceKey();
    await chmod(keyPath(), 0o644);
    resetInstanceKeyCacheForTests();
    await loadLocalInstanceKey();
    expect((await stat(keyPath())).mode & 0o777).toBe(0o600);
  });
});

describe("when the stored key cannot be unwrapped", () => {
  it("refuses to mint over a sealed key just because the keystore is absent", async () => {
    // The Electron main process injects the keystore; a load that happens
    // before it does, or while the keychain is locked, sees `isAvailable()`
    // false for a key that is perfectly intact. Rotating there would destroy
    // the registered key over a condition that clears on its own — and if the
    // re-registration then failed, the installation would be unable to sign
    // for any lease it can obtain.
    setInstanceKeyStore(fakeKeystore());
    const original = await loadLocalInstanceKey();
    const bytesBefore = await readFile(keyPath(), "utf8");

    setInstanceKeyStore(null);
    resetInstanceKeyCacheForTests();
    await expect(loadLocalInstanceKey()).rejects.toThrow(/keystore/i);
    expect(await readFile(keyPath(), "utf8")).toBe(bytesBefore);

    // …and it comes back on its own once the keystore is injected.
    setInstanceKeyStore(fakeKeystore());
    resetInstanceKeyCacheForTests();
    expect((await loadLocalInstanceKey()).publicKey).toBe(original.publicKey);
  });

  it("does rotate a key whose ciphertext the keystore cannot decrypt", async () => {
    // The other side of the same rule: an unwrap that fails while the keystore
    // IS available is a key this machine will never read again, so minting a
    // replacement is the only way forward.
    setInstanceKeyStore(fakeKeystore());
    const original = await loadLocalInstanceKey();
    const stored = await readStored();
    await writeFile(
      keyPath(),
      JSON.stringify({ ...stored, privateKey: "garbage-not-sealed" }),
    );
    resetInstanceKeyCacheForTests();
    const rotated = await loadLocalInstanceKey();
    expect(rotated.publicKey).not.toBe(original.publicKey);
  });

  it("rotates a key file that is not JSON at all", async () => {
    await mkdir(localHarnessStateRoot(), { recursive: true, mode: 0o700 });
    await writeFile(keyPath(), "{ this is not json", { mode: 0o600 });
    const key = await loadLocalInstanceKey();
    expect(key.publicKey.length).toBeGreaterThan(20);
    expect((await readStored()).publicKey).toBe(key.publicKey);
  });
});

describe("the proof of possession", () => {
  it("binds a signature to one method, path, lease and nonce", async () => {
    const one = await signProxiedRequest({
      method: "POST",
      path: "/v1/messages",
      jti: "jti_a",
      nonce: "n1",
      timestampMs: 1_700_000_000_000,
    });
    const [ts, nonce, signature] = one.split(".");
    expect(ts).toBe("1700000000000");
    expect(nonce).toBe("n1");
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);

    // Every field is part of the signing string, so changing any one of them
    // changes the signature — that is what stops a captured header being
    // replayed against a different request or a different lease.
    for (const changed of [
      { method: "GET" },
      { path: "/v1/messages/count_tokens" },
      { jti: "jti_b" },
      { nonce: "n2" },
      { timestampMs: 1_700_000_000_001 },
    ]) {
      const other = await signProxiedRequest({
        method: "POST",
        path: "/v1/messages",
        jti: "jti_a",
        nonce: "n1",
        timestampMs: 1_700_000_000_000,
        ...changed,
      });
      expect(other.split(".")[2]).not.toBe(signature);
    }
  });

  it("never returns the private key in any form", async () => {
    const key = await loadLocalInstanceKey();
    const header = await signProxiedRequest({
      method: "POST",
      path: "/v1/messages",
      jti: "jti",
      nonce: "n",
    });
    expect(header).not.toContain("PRIVATE KEY");
    expect(header).not.toContain(key.privateKeyPem.slice(40, 80));
  });
});

describe("reading a lease's jti", () => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  it("reads the claim out of a three-part token", () => {
    expect(leaseJti(`${encode({})}.${encode({ jti: "jti_x" })}.sig`)).toBe(
      "jti_x",
    );
  });

  it.each([
    ["not-a-token", "no dots"],
    ["a.b", "two parts"],
    ["a.b.c.d", "four parts"],
    [`${encode({})}.${encode({})}.sig`, "no jti claim"],
    [`${encode({})}.${encode({ jti: 42 })}.sig`, "jti is not a string"],
    [`${encode({})}.${encode({ jti: "" })}.sig`, "jti is empty"],
    [`${encode({})}.%%%.sig`, "payload is not base64"],
  ])("returns null for %s (%s)", (lease) => {
    expect(leaseJti(lease)).toBeNull();
  });
});

describe("the fingerprint shown to the user", () => {
  it("is short, stable, and not the key", () => {
    const a = instanceKeyFingerprint("pub-one");
    expect(a).toHaveLength(12);
    expect(a).toBe(instanceKeyFingerprint("pub-one"));
    expect(a).not.toBe(instanceKeyFingerprint("pub-two"));
    expect(a).not.toContain("pub-one");
  });
});
