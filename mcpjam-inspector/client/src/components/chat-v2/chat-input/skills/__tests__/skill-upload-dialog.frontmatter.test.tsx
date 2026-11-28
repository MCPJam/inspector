/**
 * The dialog reads a picked folder's SKILL.md before uploading it. The server
 * writes that file with a YAML serializer, which quotes or folds some values,
 * so the dialog has to read it as YAML too or it rejects the server's own
 * skills.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { uploadSkillFolder } = vi.hoisted(() => ({
  uploadSkillFolder: vi.fn(async () => ({
    name: "on",
    description: "",
    content: "",
    path: "",
  })),
}));

vi.mock("@/lib/apis/mcp-skills-api", () => ({
  uploadSkillFolder: (...args: unknown[]) => uploadSkillFolder(...args),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({ canManageMembers: false, isLoading: false }),
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { SkillUploadDialog } from "../skill-upload-dialog";

function pickSkillFolder(skillMd: string) {
  const file = new File([skillMd], "SKILL.md", { type: "text/markdown" });
  Object.defineProperty(file, "webkitRelativePath", {
    value: "skill/SKILL.md",
  });
  // jsdom's Blob has no `text()`; the dialog reads the frontmatter with it.
  Object.defineProperty(file, "text", { value: async () => skillMd });
  // Queried off the document: Radix portals the dialog outside `container`.
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file] });
  fireEvent.change(input);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SkillUploadDialog — reading SKILL.md frontmatter", () => {
  it("uploads a quoted name and a folded description as plain strings", async () => {
    const description =
      "Looks up the forecast for a city and explains it in plain words for the user";
    render(<SkillUploadDialog open onOpenChange={vi.fn()} />);

    pickSkillFolder(
      "---\nname: 'on'\ndescription: >-\n  Looks up the forecast for a city and explains it in plain words for\n  the user\n---\nBody\n",
    );

    expect(await screen.findAllByText(description)).not.toHaveLength(0);
    expect(screen.queryByText(/invalid skill name/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /upload skill/i }));

    await waitFor(() => expect(uploadSkillFolder).toHaveBeenCalled());
    expect(uploadSkillFolder.mock.calls[0][1]).toBe("on");
  });

  it("uploads a name YAML would read as a number when it is quoted", async () => {
    render(<SkillUploadDialog open onOpenChange={vi.fn()} />);

    pickSkillFolder(
      '---\nname: "123"\ndescription: "Fetches: weather data"\n---\n\nBody',
    );

    expect(
      await screen.findAllByText("Fetches: weather data"),
    ).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /upload skill/i }));

    await waitFor(() => expect(uploadSkillFolder).toHaveBeenCalled());
    expect(uploadSkillFolder.mock.calls[0][1]).toBe("123");
  });

  it("rejects frontmatter whose name is not a string", async () => {
    render(<SkillUploadDialog open onOpenChange={vi.fn()} />);

    pickSkillFolder("---\nname: 123\ndescription: Numbers\n---\n\nBody");

    expect(
      await screen.findByText(/must contain frontmatter with 'name'/i),
    ).toBeInTheDocument();
  });
});
