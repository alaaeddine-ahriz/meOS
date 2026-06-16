import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // Ignore build output and vendored / generated artifacts.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/data/**",
      "packages/desktop/src-tauri/target/**",
      "packages/desktop/src-tauri/gen/**",
      // The desktop build copies the bundled, minified web app here; like
      // target/ and gen/ above it is a gitignored build artifact, not source.
      "packages/desktop/src-tauri/payload/**",
      // Agent git worktrees live here (gitignored); never lint sibling checkouts.
      ".claude/**",
      // Vitest config files are build/test tooling, not part of any package's
      // tsconfig project — type-aware linting can't resolve them, so skip.
      "**/vitest.config.ts",
      "**/*.d.ts",
    ],
  },

  // Base JS recommended rules for every file.
  js.configs.recommended,

  // ---------------------------------------------------------------------------
  // Type-aware linting for the core and server packages.
  // ---------------------------------------------------------------------------
  {
    files: ["packages/core/**/*.ts", "packages/server/**/*.ts"],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      importPlugin.flatConfigs.recommended,
      importPlugin.flatConfigs.typescript,
    ],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
        noWarnOnMultipleProjects: true,
      },
      globals: {
        ...globals.node,
      },
    },
    settings: {
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: ["packages/core/tsconfig.json", "packages/server/tsconfig.json"],
        },
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      // Barrel re-export cycles are common in this codebase; keep as a
      // warning rather than blocking. Cross-package coupling is enforced
      // separately by dependency-cruiser (see PR #24).
      "import/no-cycle": "warn",
      "import/no-unresolved": [
        "error",
        // @meos/* workspace packages resolve to their built dist/ output,
        // which is absent before `pnpm build`; skip to avoid build-order flakiness.
        { ignore: ["^@meos/"] },
      ],
      // NodeNext requires ".js" extensions on relative imports; the import
      // plugin cannot always resolve those against source ".ts" files.
      "import/no-extraneous-dependencies": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // These type-aware rules are too noisy for this codebase's current
      // shape (heavy use of AI SDK / sqlite dynamic values). Downgraded to
      // keep signal high without a behavioural rewrite.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/require-await": "warn",
      "@typescript-eslint/unbound-method": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
    },
  },

  // ---------------------------------------------------------------------------
  // Test files live outside the build tsconfig's `include` (src only), so they
  // are not part of the project service. Lint them without type-aware rules.
  // ---------------------------------------------------------------------------
  {
    files: ["packages/**/test/**/*.ts", "packages/**/*.test.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: null,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // ---------------------------------------------------------------------------
  // React-specific rules for the web package (not type-aware: bundler resolution
  // + JSX make full type-checked linting expensive and noisy here).
  // ---------------------------------------------------------------------------
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    extends: [
      ...tseslint.configs.recommended,
      reactPlugin.configs.flat.recommended,
      reactPlugin.configs.flat["jsx-runtime"],
      importPlugin.flatConfigs.recommended,
      importPlugin.flatConfigs.typescript,
    ],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      react: { version: "detect" },
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: ["packages/web/tsconfig.json"],
        },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      // Barrel re-export cycles abound in the vendored tiptap-ui components;
      // keep as a warning. Hooks/rules-of-hooks errors are still enforced.
      "import/no-cycle": "warn",
      "import/no-unresolved": "error",
      "react/prop-types": "off",
      "react/no-unescaped-entities": "warn",
      // react-hooks v7 ships several new experimental, error-level lints that
      // are too strict for this existing codebase. Keep them as warnings so
      // the core rules-of-hooks / exhaustive-deps remain useful.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // Node build/tooling scripts and root config files run in Node.
  {
    files: [
      "scripts/**/*.{js,mjs,cjs}",
      "benchmarks/**/*.{js,mjs,cjs}",
      "*.{js,mjs,cjs}",
      "**/*.config.{js,mjs,cjs,ts}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Disable rules that conflict with Prettier formatting.
  {
    rules: {
      "no-unexpected-multiline": "off",
    },
  },
);
