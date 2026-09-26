// Flat config. Deliberately narrow: this exists to catch the CLASS of bug that
// actually shipped in this codebase (stale closures in effects, unused code),
// not to enforce house style. Rules that would only produce churn are off.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    // Only src/ holds lintable app code. Everything else is build output,
    // vendored deps, or non-TS tooling. `release/**` and the tester folders
    // matter especially: they contain packaged .app bundles, and letting
    // ESLint walk those binaries makes `npm run lint` hang for minutes.
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "scripts/**",
      "release/**",
      "decks bridge*/**",
      "windows/**",
      "**/*.app/**",
      "*.config.*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: {
        window: "readonly", document: "readonly", navigator: "readonly",
        localStorage: "readonly", sessionStorage: "readonly", console: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly",
        clearInterval: "readonly", fetch: "readonly", performance: "readonly",
        URL: "readonly", DOMException: "readonly", Response: "readonly",
        AbortController: "readonly", HTMLInputElement: "readonly", React: "readonly",
      },
    },
    rules: {
      // The rule that would have caught the PairingScreen stale-closure race.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "off", // diagnostics are a feature here
    },
  }
);
