import { build } from "esbuild";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function buildWorker() {
  mkdirSync(resolve(root, "dist"), { recursive: true });
  await build({
    entryPoints: [resolve(root, "src/index.ts")],
    outfile: resolve(root, "dist/worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });
  console.log("Built Worker bundle.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await buildWorker();
}
