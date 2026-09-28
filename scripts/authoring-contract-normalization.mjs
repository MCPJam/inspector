import ts from "typescript";
// Compare lexical tokens: delimiters may differ, but literal VALUES must not.
export const normalizeAuthoringContract = (text) => {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    text.slice(text.indexOf("export const EVAL_AUTHORING_VERSION"))
  );
  const tokens = [];
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    tokens.push([
      token,
      token === ts.SyntaxKind.StringLiteral
        ? scanner.getTokenValue()
        : scanner.getTokenText(),
    ]);
  }
  return JSON.stringify(tokens);
};
