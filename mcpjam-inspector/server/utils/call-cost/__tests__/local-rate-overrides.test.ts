import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalRateOverrideStore,
  LocalRateOverrideError,
} from "../local-rate-overrides.js";

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const llama = { providerKey: "ollama", modelId: "llama3.2" };

describe("local rate overrides", () => {
  let dir: string;
  let file: string;
  let store: ReturnType<typeof createLocalRateOverrideStore>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rate-overrides-"));
    file = join(dir, "inspector", "model-rate-overrides.json");
    store = createLocalRateOverrideStore(() => file);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rateAt = (at: number) =>
    store.rateFor({ ...llama, modelIds: ["llama3.2"], at });

  it("keeps each save as a revision and prices a call by its own time", async () => {
    const first = await store.set(
      { ...llama, rates: { input: 1, output: 2 }, effectiveAt: NOW - 10 * DAY },
      NOW - 10 * DAY,
    );
    const second = await store.set(
      { ...llama, rates: { input: 3, output: 4 }, effectiveAt: NOW + DAY },
      NOW,
    );

    expect([first.revision, second.revision]).toEqual([1, 2]);
    // The newest revision is listed even before it takes effect.
    expect(await store.list()).toEqual([second]);
    expect(
      (await store.history("ollama", "llama3.2")).map((r) => r.revision),
    ).toEqual([2, 1]);
    expect((await rateAt(NOW))?.versionId).toBe(first.rateId);
    expect(await rateAt(NOW + 2 * DAY)).toMatchObject({
      source: "customer_rate",
      versionId: second.rateId,
      rates: { currency: "USD", input: 3, output: 4 },
    });
    expect(await rateAt(NOW - 20 * DAY)).toBeUndefined();
  });

  it("stops applying a retired rate from then on, and starts again when saved anew", async () => {
    const saved = await store.set(
      { ...llama, rates: { input: 1, output: 2 }, effectiveAt: NOW - 10 * DAY },
      NOW - 10 * DAY,
    );
    await store.retire(saved.rateId, NOW - 5 * DAY);

    expect(await store.list()).toEqual([]);
    expect(await rateAt(NOW - 7 * DAY)).toMatchObject({
      versionId: saved.rateId,
    });
    expect(await rateAt(NOW)).toBeUndefined();

    const again = await store.set(
      { ...llama, rates: { input: 5, output: 6 } },
      NOW,
    );
    expect(again.revision).toBe(2);
    expect(await rateAt(NOW + 1)).toMatchObject({ versionId: again.rateId });
  });

  it("refuses to retire a revision someone already replaced", async () => {
    const old = await store.set(
      { ...llama, rates: { input: 1, output: 2 } },
      NOW,
    );
    await store.set({ ...llama, rates: { input: 3, output: 4 } }, NOW + 1);

    await expect(store.retire(old.rateId)).rejects.toMatchObject({
      code: "changed",
    });
    await expect(store.retire("missing")).rejects.toBeInstanceOf(
      LocalRateOverrideError,
    );
  });

  it("refuses an invalid rate with the message to show", async () => {
    await expect(
      store.set({ ...llama, rates: { input: -1, output: 2 } }),
    ).rejects.toMatchObject({
      code: "invalid_rate",
      message: "Input price must be zero or more. Enter a dollar amount.",
    });
    await expect(
      store.set({ modelId: "llama3.2", rates: { input: 1, output: 2 } }),
    ).rejects.toMatchObject({
      message: "Pick the provider these prices apply to.",
    });
  });

  it("writes only to this machine, readable by this user alone", async () => {
    await store.set({ ...llama, rates: { input: 1, output: 2 } });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      version: 1,
      revisions: [{ providerKey: "ollama", modelId: "llama3.2" }],
    });
  });

  it("moves an unreadable file aside instead of overwriting it", async () => {
    await store.set({ ...llama, rates: { input: 1, output: 2 } });
    writeFileSync(file, "{ not json");

    expect(await store.list()).toEqual([]);
    await store.set({ ...llama, rates: { input: 1, output: 2 } });

    expect(readFileSync(`${file}.unreadable`, "utf8")).toBe("{ not json");
    expect(await store.list()).toHaveLength(1);
  });
});
