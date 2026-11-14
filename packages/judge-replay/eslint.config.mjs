import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["dist/**", "build/**", "node_modules/**", "playwright-report/**", "test-results/**"]
  },
  {
    files: ["src/**/*.{ts,tsx}", "demo/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true }
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-restricted-properties": [
        "error",
        {
          "property": "dangerouslySetInnerHTML",
          "message": "Untrusted evidence must never be rendered as raw HTML."
        }
      ]
    }
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-console": "error"
    }
  }
];
