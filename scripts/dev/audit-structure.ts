import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const ignored = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"]);
const markers: string[] = [];
function visit(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.name === ".gitkeep") markers.push(relative(root, path));
  }
}
visit(root);
for (const marker of markers) console.log(marker);
console.log(`${markers.length} .gitkeep placeholder(s) in ${relative(process.cwd(), root) || "."}`);
if (process.argv.includes("--strict") && markers.length) process.exitCode = 1;
