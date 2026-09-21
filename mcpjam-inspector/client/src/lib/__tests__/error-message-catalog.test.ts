import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "../error-messages";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ["__tests__", "test", "generated"].includes(entry.name)
        ? []
        : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("error message catalog", () => {
  it("has nonempty text for every entry", () => {
    for (const [key, message] of Object.entries(ERROR_MESSAGES)) {
      expect(message.trim(), key).not.toBe("");
    }
  });

  it("keeps static toast and inline error setter messages in the catalog", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(clientRoot)) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      function check(expression: ts.Expression): void {
        if (
          (ts.isStringLiteral(expression) ||
            ts.isNoSubstitutionTemplateLiteral(expression)) &&
          expression.text.trim()
        ) {
          const line =
            source.getLineAndCharacterOfPosition(expression.getStart(source))
              .line + 1;
          violations.push(`${file}:${line}`);
        } else if (ts.isConditionalExpression(expression)) {
          check(expression.whenTrue);
          check(expression.whenFalse);
        } else if (
          ts.isBinaryExpression(expression) &&
          [
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(expression.operatorToken.kind)
        ) {
          check(expression.left);
          check(expression.right);
        }
      }
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && node.arguments[0]) {
          const callee = node.expression.getText(source);
          if (callee === "toast.error" || /^set\w*Error$/.test(callee))
            check(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(violations).toEqual([]);
  });
});
