/**@type {import("eslint").Linter.Config} */
// eslint-disable-next-line no-undef
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: [
    "@typescript-eslint",
  ],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended-type-checked",
  ],
  rules: {
    "semi": ["warn", "always"],
    "quotes": ["warn", "double"],
    "no-constant-condition": ["warn", { checkLoops: false }],
    "arrow-parens": ["warn", "as-needed"],
    "curly": ["warn", "multi-line", "consistent"],
    "indent": ["warn", 2, { SwitchCase: 1 }],
    // FIXME: "no-console": ["warn", { allow: ["error", "warn"] }],
    "object-shorthand": ["warn", "always", { avoidQuotes: true }],
    "quote-props": ["warn", "consistent-as-needed"],
    "no-useless-rename": "warn",
    "sort-imports": ["warn", {
      ignoreDeclarationSort: true
    }],

    "@typescript-eslint/no-unused-vars": 0,
    "@typescript-eslint/no-explicit-any": 0,
    "@typescript-eslint/explicit-module-boundary-types": 0,
    "@typescript-eslint/no-non-null-assertion": 0,
  },

  parser: "@typescript-eslint/parser",
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: true,
  },
};
