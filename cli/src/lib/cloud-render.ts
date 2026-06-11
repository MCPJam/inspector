import type {
  ListProjectServersResult,
  PlatformProject,
  ShowServersPayload,
} from "@mcpjam/sdk/platform";

function formatTimestamp(value: number | null | undefined): string {
  return typeof value === "number" ? new Date(value).toISOString() : "-";
}

function table(rows: string[][]): string[] {
  if (rows.length === 0) {
    return [];
  }
  const widths = rows[0].map((_cell, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths[column]),
      )
      .join("  ")
      .trimEnd(),
  );
}

export function formatProjectsHuman(projects: PlatformProject[]): string {
  if (projects.length === 0) {
    return "No accessible projects.";
  }

  const lines = table([
    ["ID", "NAME", "UPDATED"],
    ...projects.map((project) => [
      project.id,
      project.name,
      formatTimestamp(project.updatedAt),
    ]),
  ]);
  lines.push("", `${projects.length} project(s).`);
  return lines.join("\n");
}

export function formatProjectServersHuman(
  result: ListProjectServersResult,
): string {
  const lines = [`Project: ${result.project.name} (${result.project.id})`, ""];

  if (result.items.length === 0) {
    lines.push("No servers in this project.");
  } else {
    lines.push(
      ...table([
        ["ID", "NAME", "TRANSPORT", "URL", "ENABLED"],
        ...result.items.map((server) => [
          server.id,
          server.name,
          server.transportType,
          server.url ?? "-",
          server.enabled ? "yes" : "no",
        ]),
      ]),
    );
  }

  appendOtherProjects(lines, result.otherProjects);
  return lines.join("\n");
}

export function formatShowServersHuman(payload: ShowServersPayload): string {
  const lines = [
    `Project: ${payload.project.name} (${payload.project.id})`,
    "",
  ];

  if (payload.servers.length === 0) {
    lines.push("No servers in this project.");
  } else {
    for (const server of payload.servers) {
      const headline = `${statusGlyph(server.status)} ${server.name} [${server.status}]`;
      lines.push(server.url ? `${headline} ${server.url}` : headline);
      if (server.statusDetail) {
        lines.push(`    ${server.statusDetail}`);
      }
      if (server.serverInfo?.name || server.serverInfo?.version) {
        lines.push(
          `    Server: ${server.serverInfo.name ?? "unknown"}${server.serverInfo.version ? ` v${server.serverInfo.version}` : ""}`,
        );
      }
      if (server.primitives) {
        lines.push(
          `    Primitives: tools ${server.primitives.tools.items.length}, resources ${server.primitives.resources.items.length}, prompts ${server.primitives.prompts.items.length}`,
        );
      }
    }
  }

  const summary = payload.summary;
  lines.push(
    "",
    `Summary: ${summary.reachable} reachable, ${summary.unreachable} unreachable, ${summary.skipped} skipped, ${summary.error} error(s).`,
  );
  appendOtherProjects(lines, payload.otherProjects);
  lines.push(`Generated at ${payload.generatedAt}.`);
  return lines.join("\n");
}

function appendOtherProjects(
  lines: string[],
  otherProjects: Array<{ id: string; name: string }>,
): void {
  if (otherProjects.length > 0) {
    lines.push(
      "",
      `Other projects: ${otherProjects
        .map((project) => project.name)
        .join(", ")} (switch with --project)`,
    );
  }
}

function statusGlyph(
  status: "reachable" | "unreachable" | "skipped" | "error",
): string {
  switch (status) {
    case "reachable":
      return "✓";
    case "unreachable":
      return "✗";
    case "skipped":
      return "-";
    case "error":
      return "!";
  }
}
