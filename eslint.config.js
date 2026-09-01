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
    ignores: ["node_modules/**", "dist/**", "**/fixtures/**"],
  },
];
