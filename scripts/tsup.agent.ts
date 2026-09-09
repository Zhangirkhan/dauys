import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["apps/mac-agent/src/index.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node24",
  clean: true,
  splitting: false,
  skipNodeModulesBundle: false,
  noExternal: [/.*/],
  external: ["node:sqlite", "node:sea"],
});
