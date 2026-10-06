// Bundle the CLI into the plugin (plugins/zai/dist/zai.js, committed so installs need no build).
// `--check` rebuilds to memory and fails when the committed bundle is stale.
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const outfile = "plugins/zai/dist/zai.js";
const check = process.argv.includes("--check");
const result = await build({
  entryPoints: ["src/cli/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  write: !check,
  legalComments: "none",
  // Dependencies such as yaml are CommonJS and require() node builtins, which an ESM bundle has no require for.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __zaiCreateRequire } from "node:module";',
      "const require = __zaiCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // Module paths in the bundle's comments stay node_modules/..., whether node_modules is a directory or a symlink.
  preserveSymlinks: true,
});
if (check) {
  const fresh = result.outputFiles[0].text;
  const committed = await readFile(outfile, "utf8").catch(() => "");
  if (fresh !== committed) {
    console.error(`${outfile} is stale: run npm run build`);
    process.exit(1);
  }
  console.log(`${outfile} is fresh`);
}
