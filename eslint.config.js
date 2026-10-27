import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// One config for the whole repo: the recommended rules, plus the hooks rules for the
// React app. Formatting is left to the editor; this is for mistakes, not style.
export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "server/data/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // A leading underscore marks a parameter or binding as deliberately unused, e.g.
    // Express needs all four arguments to recognise an error handler.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["server/**/*.ts", "scripts/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    // The two classic hooks rules. The plugin's newer React Compiler rules flag the
    // reset-on-change effects this app uses on purpose, which isn't worth a rewrite.
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
