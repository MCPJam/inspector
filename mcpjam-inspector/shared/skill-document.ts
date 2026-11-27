import { splitSkillMarkdown } from "@mcpjam/sdk/browser";

/**
 * The Inspector accepts YAML frontmatter; skill files cannot select a parser.
 * The server and the folder upload dialog both read SKILL.md through this, so
 * the dialog accepts the same files the server does.
 */
export function readSkillDocument(fileContent: string) {
  // Preserve the optional BOM, explicit YAML marker and trailing blanks accepted
  // by older skill files while passing only the standard delimiter to the SDK.
  const markdown = fileContent.replace(/^﻿?---(?:yaml)?[ \t]*(?=\r?\n)/, "---");
  return splitSkillMarkdown(markdown);
}
