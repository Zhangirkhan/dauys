import { readFileSync, writeFileSync } from "node:fs";

for (const path of process.argv.slice(2)) {
  const next = readFileSync(path, "utf8")
    .replaceAll('from "sqlite"', 'from "node:sqlite"')
    .replaceAll("from 'sqlite'", "from 'node:sqlite'")
    .replaceAll('require("sqlite")', 'require("node:sqlite")')
    .replaceAll("require('sqlite')", "require('node:sqlite')")
    .replaceAll('from "sea"', 'from "node:sea"')
    .replaceAll("from 'sea'", "from 'node:sea'")
    .replaceAll('require("sea")', 'require("node:sea")')
    .replaceAll("require('sea')", "require('node:sea')");
  writeFileSync(path, next);
}
