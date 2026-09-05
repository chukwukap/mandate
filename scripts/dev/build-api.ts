import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Bundle workspace TypeScript; keep third-party packages in node_modules for Node.
const external = new Set<string>(["pg-native"]);
for (const group of ["apps", "packages"]) {
  for (const name of await readdir(group)) {
    const manifest = JSON.parse(await readFile(`${group}/${name}/package.json`, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, version] of Object.entries(manifest.dependencies ?? {}))
      if (!version.startsWith("workspace:")) external.add(name);
  }
}
const result = await Bun.build({
  entrypoints: [resolve("apps/api/src/main.ts")],
  outdir: resolve("apps/api/dist"),
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: [...external],
});
if (!result.success) {
  console.error(result.logs);
  process.exitCode = 1;
} else console.log("Built Node.js API: apps/api/dist/main.js");
