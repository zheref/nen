module.exports = {
  watchman: false,
  testEnvironment: "jsdom",
  transform: { "^.+\\.[jt]sx?$": "<rootDir>/jest-preprocess.cjs" },
  moduleNameMapper: { "\\.(css|less|sass|scss)$": "identity-obj-proxy", "\\.(jpg|jpeg|png|gif|svg)$": "<rootDir>/__mocks__/file.cjs" },
  testPathIgnorePatterns: ["node_modules", "\\.cache", "public"],
  transformIgnorePatterns: ["node_modules/(?!(gatsby)/)"],
  globals: { __PATH_PREFIX__: "" },
  setupFilesAfterEnv: ["<rootDir>/setup-test-env.cjs"],
  collectCoverageFrom: ["src/components/**/*.jsx"],
};
