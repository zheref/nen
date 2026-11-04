# Gatsby/Jest adoption fixture

This is a small, real Gatsby5 / React18 / Jest29 / React Testing Library recipe, based on Gatsby's official [unit testing](https://www.gatsbyjs.com/docs/how-to/testing/unit-testing/) and [React component testing](https://www.gatsbyjs.com/docs/how-to/testing/testing-react-components/) guides. The Gatsby manual mock keeps actual Gatsby exports and controls browser navigation. Babel, CSS module mapping, jsdom and jest-dom are exercised by two JSX tests. Watchman is explicitly disabled: batch tests need no host service.

Copy this directory to a fresh temporary directory, install its exact direct dependency pins locally, then run Nen against it. Author verification used `npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps --cache <temporary-cache>` there, followed by:

```text
nen shu test --repo <fixture> --json
nen shu test-report --repo <fixture> --from-artifacts --json
nen shu coverage --repo <fixture> --json
```

No host/global installation is required. The temporary install suppresses lifecycle scripts and legacy Gatsby peer-resolution conflicts; this proves the Jest/Babel/browser-entry recipe, not Gatsby native build or deployment. It is not an instruction to suppress a consumer application's required install steps. The fixture pins direct packages rather than making a latest-version claim. The recommendations are catalogue data, never execution authority. A consumer must adopt/configure dependencies, mocks and its actual source selection, then declare its own commands/artifacts. `ui-test` remains unsupported: jsdom component tests do not establish browser E2E coverage.

`nen/contract.json` names the repository-local Jest entrypoint and reports explicitly. `collectCoverageFrom` includes source files whether tested or not. LCOV is parsed by Nen; `jest-results.json` is parsed as assertion-results. The fixture workflow keeps required `test` and the touched80/85/90 ladder. Existing Nen coverage semantics are unchanged: exit0 can mean a successful measurement with `threshold.met:false` or an `under-minimum` ladder band; neither says policy passed. A failed Jest assertion still exits1.

The small proof record in `proof.json` reports actual author-run results. It does not imply this recipe has already been adopted by zheref.io, or that its real site's tests/coverage passed. Ordinary CI tests validate the catalogue and unsupported-output contract without downloading dependencies; replaying this optional real fixture is explicit.
