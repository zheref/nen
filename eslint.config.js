// eslint.config.js -- flat config, TypeScript-only.
//
// Carried from bankai-core's cli/eslint.config.js (BC-11: this package carries
// no shell/Python beyond the ONE bootstrap file, which eslint does not read).
// `strict` + `noUncheckedIndexedAccess` are enforced by tsconfig.json's
// typecheck script, not by eslint -- this config is style/correctness only.
//
// TWO BLOCKS RATHER THAN ONE. `src/**/*.ts` is typechecked-by-project; the root
// `*.config.ts` files are matched by the same rules but with no `project`, so a
// config file that tsconfig's `include` does not cover cannot fail the lint with
// a "file not found in project" parser error. That failure mode is worth naming:
// it is the reason a repo ends up with `--no-eslintrc` escape hatches.
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

const rules = {
  ...tseslint.configs.recommended.rules,
  "@typescript-eslint/no-unused-vars": "error",
  "@typescript-eslint/explicit-function-return-type": "error",
};

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules,
  },
  {
    files: ["*.config.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { sourceType: "module" },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules,
  },
  {
    // `.claude/**` -- Kurapika's own worktrees live under `.claude/worktrees/`
    // (see .gitignore), each one a FULL checkout with its own `coverage/`,
    // `node_modules/` and `dist/`. Every pattern in this array is anchored to
    // THIS config's own directory (see the file header on why two blocks exist
    // above, and note ESLint's flat-config `ignores` does NOT match at any
    // depth the way gitignore does) -- so `coverage/**` alone ignores the
    // root's own report but not `.claude/worktrees/<branch>/coverage/**` one
    // directory further down, and `eslint .` swept a sibling worktree's
    // generated `coverage/lcov-report/*.js`, warning on its stale
    // `eslint-disable` comments on every `nen shu lint` run in a checkout that
    // happened to have another worktree sitting there. `.claude/` carries no
    // source this repository lints -- it is untracked (see .gitignore).
    ignores: ["node_modules/**", "dist/**", "**/fixtures/**", "coverage/**", ".claude/**"],
  },
];
