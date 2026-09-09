import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  }
).version;

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
  // Bake version into CJS/SEA bundle — import.meta is empty under format:cjs.
  define: {
    __DAUYS_AGENT_VERSION__: JSON.stringify(version),
  },
});
