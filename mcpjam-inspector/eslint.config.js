// @ts-check
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["server/routes/web/**/*.ts"],
    languageOptions: {
      parser: tsParser,
    },
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='logger'][callee.property.name=/^(warn|error|info)$/]",
          message:
            "Use logger.event() for production diagnostics in server/routes/web/. " +
            "Free-form logger.warn/error/info calls are not queryable in Axiom. " +
            "See server/utils/LOGGING.md for the typed event catalog.",
        },
      ],
    },
  },
];
