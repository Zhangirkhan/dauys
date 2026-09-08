import { readFileSync, writeFileSync } from "node:fs";

for (const path of process.argv.slice(2)) {
  const next = readFileSync(path, "utf8")
    .replaceAll('from "sqlite"', 'from "node:sqlite"')
    .replaceAll("from 'sqlite'", "from 'node:sqlite'");
  writeFileSync(path, next);
}
