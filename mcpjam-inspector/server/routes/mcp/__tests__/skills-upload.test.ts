import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const { join } = await import("node:path");
  const home = join(actual.tmpdir(), `skills-upload-${process.pid}`);
  return { ...actual, default: { ...actual, homedir: () => home } };
});

import skills from "../skills";

const home = path.join(os.tmpdir(), `skills-upload-${process.pid}`);
const skillDir = path.join(home, ".mcpjam", "skills", "weather");

function upload(body: Record<string, unknown>) {
  return skills.request("/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("POST /skills/upload", () => {
  it.each([
    { name: "weather", description: "Weather", content: 5 },
    { name: "weather", description: 5, content: "Body" },
    { name: 5, description: "Weather", content: "Body" },
  ])("refuses a non-string field with 400 before writing: %o", async (body) => {
    const res = await upload(body);

    expect(res.status).toBe(400);
    expect(fs.existsSync(skillDir)).toBe(false);
  });

  it("writes a skill whose fields are strings", async () => {
    const res = await upload({
      name: "weather",
      description: "Fetches: weather data",
      content: "Body",
    });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")).toBe(
      '---\nname: weather\ndescription: "Fetches: weather data"\n---\n\nBody',
    );
  });
});
