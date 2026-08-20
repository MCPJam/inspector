/**
 * What the OpenAI readiness reader is told about an ARCHIVE, as opposed to the
 * files inside it.
 *
 * The distinction is the point. Every path rule the portal enforces is checked
 * against the names the archive's central directory recorded, BEFORE anything
 * normalizes them — because normalization repairs a backslash separator and a
 * doubled segment, which are two of the things the portal rejects. An adapter
 * that reported normalized names would hand the reader a package that looks
 * clean and gets rejected on upload.
 *
 * The other half is absence. Every field this adapter cannot establish must be
 * ABSENT rather than empty, because the reader turns absence into a recorded
 * gap and emptiness into "checked, none found".
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import {
  DIRECTORY_ARCHIVE_OBSERVATIONS,
  collectZipArchiveObservations,
} from "../bundle-file-sources.js";

const encoder = new TextEncoder();

async function zipOf(entries: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) {
    zip.file(path, encoder.encode(content));
  }
  return zip.generateAsync({ type: "uint8array" });
}

describe("collectZipArchiveObservations", () => {
  it("reports the uploaded byte length, which is what the size limit measures", async () => {
    const bytes = await zipOf({ "plugin.json": "{}" });
    const observed = await collectZipArchiveObservations(bytes);
    expect(observed.compressedBytes).toBe(bytes.byteLength);
  });

  it("reports a backslash separator as the archive spelled it", async () => {
    // A backslash separator is one of the things the portal rejects and
    // `normalizeBundlePath` repairs, so it is exactly the name that must reach
    // the reader untouched: normalize first and the package reads clean right
    // up until the upload bounces.
    //
    // Backslash rather than `a//b` or `./c` because JSZip's WRITER collapses
    // those two on the way in — a fixture cannot produce them through this
    // API, so asserting on them would test the fixture, not the adapter.
    const bytes = await zipOf({
      "plugin.json": "{}",
      "skills\\weather\\SKILL.md": "name: w",
    });
    const observed = await collectZipArchiveObservations(bytes);
    expect(observed.rawEntryNames).toContain("skills\\weather\\SKILL.md");
  });

  it("distinguishes an EMPTY archive from an unread one", async () => {
    // The boundary this whole module is about: `[]` is a measurement — the
    // archive was read and held nothing — and absence is a gap. An empty
    // archive is the case where those two are easiest to swap by accident.
    const observed = await collectZipArchiveObservations(await zipOf({}));
    expect(observed.rawEntryNames).toEqual([]);
    expect(observed.compressedBytes).toBeGreaterThan(0);
  });

  it("states every archive fact as absent for a directory source", () => {
    // An extracted tree has no compressed size, no encryption flags and no
    // pre-normalization names. Every field absent is the honest report, and
    // the reader turns each one into a named gap.
    expect(DIRECTORY_ARCHIVE_OBSERVATIONS.compressedBytes).toBeUndefined();
    expect(DIRECTORY_ARCHIVE_OBSERVATIONS.rawEntryNames).toBeUndefined();
    expect(DIRECTORY_ARCHIVE_OBSERVATIONS.encryptedEntryPaths).toBeUndefined();
  });

  it("leaves encryption flags ABSENT rather than empty", async () => {
    // JSZip cannot enumerate encrypted entries at all. Reporting `[]` would
    // assert "checked, none found" for a check that never ran.
    const observed = await collectZipArchiveObservations(
      await zipOf({ "plugin.json": "{}" }),
    );
    expect(observed.encryptedEntryPaths).toBeUndefined();
  });

  it("survives an archive it cannot read, keeping the one fact it still has", async () => {
    // The usual shape of this is a password-protected zip: JSZip rejects it
    // outright rather than listing entries. Letting that reject escape would
    // turn a gradeable submission into a crashed run — and an encrypted upload
    // is precisely a case the report exists to explain. The size survives
    // because it is measured on the bytes, not read out of the archive.
    const notAZip = encoder.encode("PK and then nothing valid");
    const observed = await collectZipArchiveObservations(notAZip);
    expect(observed.compressedBytes).toBe(notAZip.byteLength);
    // Everything the archive would have had to be read to learn stays absent,
    // so the reader records a gap instead of a pass.
    expect(observed.rawEntryNames).toBeUndefined();
    expect(observed.encryptedEntryPaths).toBeUndefined();
  });
});
