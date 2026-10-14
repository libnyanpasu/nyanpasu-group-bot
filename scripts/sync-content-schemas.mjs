import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const sourceDirectory = join(projectDirectory, "schemas");
const privateContentDirectory = join(projectDirectory, "private-content");
const targetDirectory = join(privateContentDirectory, "schemas");
const schemaFiles = [
  "question.schema.json",
  "pack.schema.json",
  "rules.schema.json",
  "blocklist.schema.json",
];
const checkOnly = process.argv.slice(2).includes("--check");
const invalidArguments = process.argv.slice(2).filter((argument) => argument !== "--check");

if (invalidArguments.length > 0) {
  throw new Error(
    `Unknown argument(s): ${invalidArguments.join(" ")}\nUsage: node scripts/sync-content-schemas.mjs [--check]`,
  );
}

if (!existsSync(join(privateContentDirectory, ".git"))) {
  console.log("private-content checkout is not present; skipping schema sync.");
} else if (checkOnly) {
  const mismatched = schemaFiles.filter((file) => {
    const source = join(sourceDirectory, file);
    const target = join(targetDirectory, file);
    return !existsSync(target) || !readFileSync(source).equals(readFileSync(target));
  });
  if (mismatched.length > 0) {
    console.error(`Schema copies are missing or out of date: ${mismatched.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("Private content schemas match the parent repository.");
  }
} else {
  mkdirSync(targetDirectory, { recursive: true });
  for (const file of schemaFiles) {
    copyFileSync(join(sourceDirectory, file), join(targetDirectory, file));
  }
  console.log(`Synced ${schemaFiles.length} content schemas to private-content/schemas.`);
}
