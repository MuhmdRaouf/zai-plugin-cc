// Composition root: wires adapters into Deps and hands argv to runCli. Kept free of logic (excluded from coverage).
import { runCli } from "./run.ts";
import { wire } from "./wire.ts";

const write = (stream: NodeJS.WriteStream) => (text: string) => stream.write(`${text}\n`);
const deps = wire({
  env: process.env,
  bundlePath: process.argv[1] ?? "",
  out: { line: write(process.stdout), error: write(process.stderr) },
});
const code = await runCli(process.argv.slice(2), deps, process.cwd());
// Pipes are asynchronous: exit only once both streams have flushed.
await Promise.all(
  [process.stdout, process.stderr].map((stream) => new Promise((done) => stream.write("", done))),
);
process.exit(code);
