/**
 * The corpus lock's disk contract.
 *
 * Two properties are worth more than the rest, and both are about what happens
 * when something goes wrong:
 *
 *  - A failed write leaves the PREVIOUS lock intact and no temp file behind.
 *    A half-written lock does not look broken; it looks like a corpus that
 *    lost cases, and the next `--frozen` run reports drift nobody caused.
 *  - No infrastructure condition maps to exit 1. Exit 1 means "the corpus
 *    drifted" and nothing else. A missing lock, an unreadable one and a failed
 *    fetch are all exit 3.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CORPUS_LOCK_VERSION, type CorpusDrift, type CorpusLock } from "@mcpjam/sdk";
import {
  CORPUS_DRIFT_EXIT_CODE,
  CORPUS_INCOMPLETE_EXIT_CODE,
  CORPUS_USAGE_EXIT_CODE,
  corpusFetchFailure,
  readCorpusLock,
  renderCorpusDrift,
  writeCorpusLockAtomic,
} from "../src/lib/corpus-lock.js";
import { CliError, cliError, usageError } from "../src/lib/output.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-corpus-lock-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function lockFixture(overrides: Partial<CorpusLock> = {}): CorpusLock {
  return {
    lockVersion: CORPUS_LOCK_VERSION,
    suite: { id: "suite_1", name: "Refunds" },
    fetchedAt: "2026-08-15T00:00:00.000Z",
    evaluationConfigHash: "hash_aggregate",
    cases: [],
    ...overrides,
  };
}

/** The exit code a thrown CliError carries, or `undefined` if it threw nothing. */
async function exitCodeOf(run: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
    return error.exitCode;
  }
}

describe("readCorpusLock", () => {
  test("a missing lock is incomplete, not a drift verdict", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "mcpjam-evals.lock.json");
      const code = await exitCodeOf(() => readCorpusLock(target));
      // The whole point of the contract: "you never pulled" must not read as
      // "your corpus changed".
      assert.equal(code, CORPUS_INCOMPLETE_EXIT_CODE);
      assert.notEqual(code, CORPUS_DRIFT_EXIT_CODE);
    });
  });

  test("names the command to run", async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(
        () => readCorpusLock(path.join(dir, "missing.json")),
        /mcpjam cloud eval pull/
      );
    });
  });

  test("malformed JSON is incomplete", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "lock.json");
      await writeFile(target, "{ not json", "utf8");
      assert.equal(
        await exitCodeOf(() => readCorpusLock(target)),
        CORPUS_INCOMPLETE_EXIT_CODE
      );
    });
  });

  test("a lock missing its required fields is incomplete", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "lock.json");
      await writeFile(target, JSON.stringify({ suite: { id: "s" } }), "utf8");
      assert.equal(
        await exitCodeOf(() => readCorpusLock(target)),
        CORPUS_INCOMPLETE_EXIT_CODE
      );
    });
  });

  test("a different lockVersion is refused rather than compared", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "lock.json");
      await writeFile(
        target,
        JSON.stringify(lockFixture({ lockVersion: CORPUS_LOCK_VERSION + 1 })),
        "utf8"
      );
      // Comparing across versions would report drift on every case in the
      // file, because the content hash is over a VERSIONED allowlist.
      await assert.rejects(() => readCorpusLock(target), /not comparable/);
      assert.equal(
        await exitCodeOf(() => readCorpusLock(target)),
        CORPUS_INCOMPLETE_EXIT_CODE
      );
    });
  });

  test("a structurally broken lock is incomplete, never an internal error", async () => {
    // The reason this matters is the EXIT CODE. A `null` row makes
    // `verifyCorpusLock` throw a bare TypeError reading `.scenarioKey`, which
    // normalizes to INTERNAL_ERROR and exit 1 — a malformed lock reported as
    // "your corpus drifted", sending someone to hunt an edit nobody made.
    const soundRow = {
      scenarioKey: "external:a",
      caseId: "a",
      title: "Case A",
      scenarioContentHash: "content_a",
      evaluationConfigHash: "config_a",
      iterations: 3,
      normalizedContent: { id: "a", title: "Case A" },
    };
    const broken: Array<{ label: string; lock: unknown }> = [
      { label: "a null case row", lock: lockFixture({ cases: [null] as never }) },
      {
        label: "a case row missing scenarioKey",
        lock: lockFixture({
          cases: [{ ...soundRow, scenarioKey: undefined }] as never,
        }),
      },
      {
        label: "a case row missing its content hash",
        lock: lockFixture({
          cases: [{ ...soundRow, scenarioContentHash: undefined }] as never,
        }),
      },
      {
        label: "a case row with a non-numeric iteration count",
        lock: lockFixture({
          cases: [{ ...soundRow, iterations: "3" }] as never,
        }),
      },
      {
        label: "duplicate scenario keys",
        lock: lockFixture({ cases: [soundRow, soundRow] as never }),
      },
      {
        // The key is derived from the id, and `loadCorpusFromLock` slices the
        // prefix back off with a non-null assertion.
        label: "a scenarioKey that disagrees with its caseId",
        lock: lockFixture({
          cases: [{ ...soundRow, scenarioKey: "external:somethingelse" }] as never,
        }),
      },
      // Only values JSON can actually carry. `NaN` and `Infinity` serialize to
      // `null`, so listing them here would claim coverage of guards that the
      // `null` case is really what exercises.
      ...[0, -1, 1.5, null].map((iterations) => ({
        label: `an iteration count of ${String(iterations)}`,
        lock: lockFixture({ cases: [{ ...soundRow, iterations }] as never }),
      })),
      { label: "a missing suite", lock: lockFixture({ suite: undefined as never }) },
      {
        label: "a missing aggregate hash",
        lock: lockFixture({ evaluationConfigHash: undefined as never }),
      },
    ];

    await withTempDir(async (dir) => {
      for (const [index, entry] of broken.entries()) {
        const target = path.join(dir, `broken-${index}.json`);
        await writeFile(target, JSON.stringify(entry.lock), "utf8");
        const code = await exitCodeOf(() => readCorpusLock(target));
        assert.equal(
          code,
          CORPUS_INCOMPLETE_EXIT_CODE,
          `${entry.label} should be incomplete, got exit ${code}`
        );
        assert.notEqual(
          code,
          CORPUS_DRIFT_EXIT_CODE,
          `${entry.label} must never read as drift`
        );
      }
    });
  });

  test("names the offending row so a hand-edited lock can be fixed", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "lock.json");
      await writeFile(
        target,
        JSON.stringify(
          lockFixture({
            cases: [
              {
                scenarioKey: "external:a",
                caseId: "a",
                title: "Case A",
                scenarioContentHash: "content_a",
                evaluationConfigHash: "config_a",
                iterations: 1,
                normalizedContent: { id: "a" },
              },
              { scenarioKey: "external:b" },
            ] as never,
          })
        ),
        "utf8"
      );
      // "case 1", not "this file is bad".
      await assert.rejects(() => readCorpusLock(target), /case 1/);
    });
  });

  test("round-trips a lock this CLI wrote", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "lock.json");
      const lock = lockFixture({
        cases: [
          {
            scenarioKey: "external:a",
            caseId: "a",
            title: "Case A",
            scenarioContentHash: "content_a",
            evaluationConfigHash: "config_a",
            iterations: 3,
            normalizedContent: { id: "a", title: "Case A" } as never,
          },
        ],
      });
      await writeCorpusLockAtomic(target, lock);
      assert.deepEqual(await readCorpusLock(target), lock);
    });
  });
});

describe("writeCorpusLockAtomic", () => {
  test("writes pretty JSON with a trailing newline and no temp file left over", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "mcpjam-evals.lock.json");
      const written = await writeCorpusLockAtomic(target, lockFixture());

      assert.equal(written, target);
      const body = await readFile(target, "utf8");
      assert.ok(body.endsWith("}\n"), "lock should end with a trailing newline");
      assert.ok(body.includes("\n  "), "lock should be 2-space indented");

      // The temp file is a SIBLING (rename is only atomic within a
      // filesystem), so a leak would land right here.
      const leftovers = (await readdir(dir)).filter((name) =>
        name.endsWith(".tmp")
      );
      assert.deepEqual(leftovers, []);
    });
  });

  test("a failed write leaves the previous lock intact and no temp file", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "lock.json");
      const original = lockFixture({ evaluationConfigHash: "original" });
      await writeCorpusLockAtomic(target, original);

      // A value `JSON.stringify` cannot serialize fails the write BEFORE any
      // rename — the same shape as a disk filling up mid-flight.
      const poisoned = lockFixture() as CorpusLock & { boom?: unknown };
      poisoned.boom = 1n;

      const code = await exitCodeOf(() => writeCorpusLockAtomic(target, poisoned));
      assert.equal(code, CORPUS_INCOMPLETE_EXIT_CODE);

      // The destination still holds the ORIGINAL lock, byte for byte.
      assert.deepEqual(await readCorpusLock(target), original);
      const leftovers = (await readdir(dir)).filter((name) =>
        name.endsWith(".tmp")
      );
      assert.deepEqual(leftovers, []);
    });
  });

  test("an unwritable directory is incomplete, not a drift verdict", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "no-such-subdir", "lock.json");
      const code = await exitCodeOf(() =>
        writeCorpusLockAtomic(target, lockFixture())
      );
      assert.equal(code, CORPUS_INCOMPLETE_EXIT_CODE);
    });
  });
});

describe("renderCorpusDrift", () => {
  test("says so plainly when nothing drifted", () => {
    assert.match(renderCorpusDrift([]), /matches the lock/);
  });

  test("renders all four drift kinds, keeping content and grading distinct", () => {
    const drift: CorpusDrift[] = [
      { kind: "caseAdded", scenarioKey: "external:a", title: "Added" },
      { kind: "caseRemoved", scenarioKey: "external:b", title: "Removed" },
      { kind: "contentChanged", scenarioKey: "external:c", title: "Edited" },
      { kind: "evaluationConfigChanged", scenarioKey: "external:d", title: "Regraded" },
    ];
    const rendered = renderCorpusDrift(drift);

    for (const entry of drift) {
      assert.ok(
        rendered.includes(entry.scenarioKey),
        `missing ${entry.scenarioKey}`
      );
      assert.ok(rendered.includes(entry.title), `missing ${entry.title}`);
    }
    assert.match(rendered, /4 changes/);
    // "somebody edited the case" and "somebody changed how it is graded" have
    // different fixes; collapsing them into one word hides which happened.
    assert.ok(rendered.includes("content"));
    assert.ok(rendered.includes("grading"));
    assert.match(rendered, /mcpjam cloud eval pull/);
  });

  test("counts a single change in the singular", () => {
    assert.match(
      renderCorpusDrift([
        { kind: "caseAdded", scenarioKey: "external:a", title: "Added" },
      ]),
      /1 change\)/
    );
  });
});

describe("corpusFetchFailure", () => {
  test("re-codes a transport failure to incomplete", () => {
    // `toCliError` defaults to exit 1 — the code reserved for drift. A DNS
    // failure reported as "your corpus changed" is the exact confusion the
    // exit contract exists to prevent.
    const recoded = corpusFetchFailure(
      cliError("SERVER_UNREACHABLE", "getaddrinfo ENOTFOUND", 1)
    );
    assert.equal(recoded.exitCode, CORPUS_INCOMPLETE_EXIT_CODE);
    assert.equal(recoded.code, "SERVER_UNREACHABLE");
    assert.match(recoded.message, /ENOTFOUND/);
  });

  test("leaves a usage error as a usage error", () => {
    const recoded = corpusFetchFailure(usageError("No project matched 'nope'"));
    assert.equal(recoded.exitCode, CORPUS_USAGE_EXIT_CODE);
  });

  test("normalizes a bare Error rather than letting it reach exit 1", () => {
    const recoded = corpusFetchFailure(new Error("socket hang up"));
    assert.equal(recoded.exitCode, CORPUS_INCOMPLETE_EXIT_CODE);
  });

  test("never returns exit 1 for anything it is given", () => {
    const inputs: unknown[] = [
      new Error("boom"),
      cliError("INTERNAL_ERROR", "boom", 1),
      usageError("bad flag"),
      "a bare string",
      cliError("TIMEOUT", "timed out", 3),
    ];
    for (const input of inputs) {
      assert.notEqual(
        corpusFetchFailure(input).exitCode,
        CORPUS_DRIFT_EXIT_CODE,
        `${String(input)} must not map to the drift exit code`
      );
    }
  });
});
