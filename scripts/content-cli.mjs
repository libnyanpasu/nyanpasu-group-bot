import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { assembleContentPacks, readContentDocuments } from "./content-files.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const DATABASE = "nyanpasu-group-bot";
const DEFAULT_DIRECTORY = "private-content";
const USAGE = `Usage: node scripts/content-cli.mjs <push|pull|list> [options] [pack-id...]

  push   Import the local content checkout into D1 (upsert; --prune mirrors deletes).
  pull   Export D1 content back into the checkout directory.
  list   Show the packs, question types and rules stored in D1.

Options:
  --remote     Target the remote D1 database (default: local D1)
  --dir <path> Content checkout directory (default: ${DEFAULT_DIRECTORY})
  --force      pull: overwrite existing files in the target directory
  --prune      push: delete D1 rows that are absent from the checkout
  --verbose    Print raw wrangler output on failure`;

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlTimestamp(updatedAt) {
  return Number.isSafeInteger(updatedAt) && updatedAt > 0 ? updatedAt : Date.now();
}

/**
 * Build one idempotent SQL batch that mirrors content documents into the D1
 * content tables. Payload documents are stored verbatim and validated before
 * this runs.
 */
export function buildContentSql(documents, { prune = false, updatedAt = Date.now() } = {}) {
  const timestamp = sqlTimestamp(updatedAt);
  const payload = (document) => sqlString(JSON.stringify(document));
  const statements = [];
  for (const { id, document } of documents.packs) {
    statements.push(
      `INSERT INTO packs (id, payload, updated_at) VALUES (${sqlString(id)}, ${payload(document)}, ${timestamp}) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;`,
    );
  }
  for (const { id, document } of documents.rules) {
    statements.push(
      `INSERT INTO rules (id, payload, updated_at) VALUES (${sqlString(id)}, ${payload(document)}, ${timestamp}) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;`,
    );
  }
  for (const { type, id, document } of documents.questions) {
    statements.push(
      `INSERT INTO questions (type, id, payload, updated_at) VALUES (${sqlString(type)}, ${sqlString(id)}, ${payload(document)}, ${timestamp}) ON CONFLICT(type, id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;`,
    );
  }
  if (prune) {
    if (documents.packs.length === 0) statements.push("DELETE FROM packs;");
    else
      statements.push(
        `DELETE FROM packs WHERE id NOT IN (${documents.packs.map(({ id }) => sqlString(id)).join(", ")});`,
      );
    if (documents.rules.length === 0) statements.push("DELETE FROM rules;");
    else
      statements.push(
        `DELETE FROM rules WHERE id NOT IN (${documents.rules.map(({ id }) => sqlString(id)).join(", ")});`,
      );
    if (documents.questions.length === 0) statements.push("DELETE FROM questions;");
    else {
      const byType = new Map();
      for (const { type, id } of documents.questions) {
        const ids = byType.get(type) ?? [];
        ids.push(id);
        byType.set(type, ids);
      }
      const groups = [...byType].map(
        ([type, ids]) =>
          `(type = ${sqlString(type)} AND id IN (${ids.map((id) => sqlString(id)).join(", ")}))`,
      );
      statements.push(`DELETE FROM questions WHERE NOT (${groups.join(" OR ")});`);
    }
  }
  return `${statements.join("\n")}\n`;
}

/**
 * Write content documents back into the checkout layout, restoring the
 * `$schema` markers and the stable file-per-document format.
 */
export function exportContentFiles(directory, documents, { force = false } = {}) {
  const target = resolve(directory);
  const hasContent = ["packs", "rules", "questions"].some((name) => existsSync(join(target, name)));
  if (hasContent && !force) {
    throw new Error(
      `Refusing to overwrite existing content in ${target}; pass --force to overwrite matching files.`,
    );
  }
  const write = (relativePath, schema, document) => {
    const file = join(target, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ $schema: schema, ...document }, null, 2)}\n`);
  };
  for (const { id, document } of documents.rules) {
    write(join("rules", `${id}.json`), "../schemas/rules.schema.json", document);
  }
  for (const { type, id, document } of documents.questions) {
    write(join("questions", type, `${id}.json`), "../../schemas/question.schema.json", document);
  }
  for (const { id, document } of documents.packs) {
    write(join("packs", `${id}.json`), "../schemas/pack.schema.json", document);
  }
  return {
    packs: documents.packs.length,
    rules: documents.rules.length,
    questions: documents.questions.length,
  };
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!["push", "pull", "list"].includes(command ?? "")) throw new Error(USAGE);
  const options = {
    command,
    remote: false,
    force: false,
    prune: false,
    verbose: false,
    directory: DEFAULT_DIRECTORY,
    packs: [],
  };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--remote") options.remote = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--prune") options.prune = true;
    else if (argument === "--verbose") options.verbose = true;
    else if (argument === "--dir") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--dir requires a path.\n${USAGE}`);
      options.directory = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}\n${USAGE}`);
    } else {
      options.packs.push(argument);
    }
  }
  if (options.command !== "push" && (options.prune || options.packs.length > 0)) {
    throw new Error(`Pack ids and --prune are only valid for push.\n${USAGE}`);
  }
  if (options.command !== "pull" && options.force) {
    throw new Error(`--force is only valid for pull.\n${USAGE}`);
  }
  return options;
}

let validatorPromise;

/** Bundle the shared validator so the CLI checks exactly what the Worker checks. */
export function loadContentValidator() {
  validatorPromise ??= (async () => {
    const bundle = await build({
      entryPoints: [resolve(root, "src/lib/quiz.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
    });
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
    );
    return module.validateContentPack;
  })();
  return validatorPromise;
}

function targetFlags(options) {
  return options.remote ? ["--remote"] : ["--local"];
}

function targetName(options) {
  return options.remote ? "remote D1" : "local D1";
}

async function runWrangler(arguments_, options) {
  try {
    const { stdout } = await execFileAsync("pnpm", ["exec", "wrangler", ...arguments_], {
      cwd: root,
      maxBuffer: 128 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (options.verbose) throw error;
    const status = typeof error?.code === "number" ? error.code : "unknown";
    throw new Error(
      `wrangler d1 execute failed (exit ${status}). Rerun with --verbose for raw output.`,
    );
  }
}

async function selectRows(sql, options) {
  const output = await runWrangler(
    ["d1", "execute", DATABASE, ...targetFlags(options), "--json", "--command", sql],
    options,
  );
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Unexpected non-JSON output from wrangler.");
  }
  const results = Array.isArray(parsed) ? parsed[0]?.results : undefined;
  if (!Array.isArray(results)) throw new Error("Unexpected JSON shape from wrangler.");
  return results;
}

function parsePayload(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function packVersions(rows) {
  return new Map(
    rows.map((row) => [
      row.id,
      { version: parsePayload(row.payload).version, updatedAt: row.updated_at },
    ]),
  );
}

function formatTimestamp(value) {
  if (!Number.isFinite(value)) return "unknown";
  return new Date(value).toISOString();
}

async function formatContentDirectory(target) {
  try {
    await execFileAsync(
      "pnpm",
      ["exec", "oxfmt", join(target, "packs"), join(target, "rules"), join(target, "questions")],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    console.warn("Exported files kept unformatted; run oxfmt manually if needed.");
  }
}

async function push(options) {
  const validateContentPack = await loadContentValidator();
  const documents = readContentDocuments(options.directory, true);
  let selected = documents;
  if (options.packs.length > 0) {
    const known = new Set(documents.packs.map(({ id }) => id));
    const missing = options.packs.filter((id) => !known.has(id));
    if (missing.length > 0) throw new Error(`Unknown pack id(s): ${missing.join(", ")}.`);
    const chosen = new Set(options.packs);
    const packs = documents.packs.filter(({ id }) => chosen.has(id));
    const rules = new Set(packs.map(({ document }) => document.rules));
    const types = new Set(packs.flatMap(({ document }) => document.questionTypes));
    selected = {
      packs,
      rules: documents.rules.filter(({ id }) => rules.has(id)),
      questions: documents.questions.filter(({ type }) => types.has(type)),
    };
  }
  const assembled = assembleContentPacks(selected, validateContentPack);
  if (options.packs.length === 0 && !assembled.some(({ id }) => id === "default")) {
    throw new Error("Private content must include the default pack.");
  }

  const before = packVersions(
    await selectRows("SELECT id, payload FROM packs ORDER BY id", options),
  );
  const directory = mkdtempSync(join(tmpdir(), "bot-content-"));
  const file = join(directory, "content.sql");
  writeFileSync(file, buildContentSql(selected, { prune: options.prune }), { mode: 0o600 });
  try {
    await runWrangler(
      ["d1", "execute", DATABASE, ...targetFlags(options), "--file", file],
      options,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  console.log(`Target: ${targetName(options)} (${DATABASE})`);
  for (const { id, document } of selected.packs) {
    const previous = before.get(id);
    if (!previous) console.log(`  created  ${id}@${document.version}`);
    else if (previous.version !== document.version)
      console.log(`  updated  ${id}@${previous.version} -> ${document.version}`);
    else console.log(`  replaced ${id}@${document.version} (version unchanged)`);
  }
  console.log(
    `Wrote ${selected.packs.length} pack(s), ${selected.rules.length} rules document(s), ${selected.questions.length} question(s).`,
  );
  if (!options.prune) {
    const local = new Set(documents.packs.map(({ id }) => id));
    const stale = [...before.keys()].filter((id) => !local.has(id));
    if (stale.length > 0) {
      console.log(
        `${stale.length} pack(s) in D1 are absent from the checkout; run with --prune to mirror deletes.`,
      );
    }
  }
}

async function pull(options) {
  const validateContentPack = await loadContentValidator();
  const packs = await selectRows("SELECT id, payload FROM packs ORDER BY id", options);
  if (packs.length === 0) throw new Error(`${targetName(options)} has no content packs.`);
  const rules = await selectRows("SELECT id, payload FROM rules ORDER BY id", options);
  const questions = await selectRows(
    "SELECT type, id, payload FROM questions ORDER BY type, id",
    options,
  );
  const documents = {
    packs: packs.map((row) => ({ id: row.id, document: parsePayload(row.payload) })),
    rules: rules.map((row) => ({ id: row.id, document: parsePayload(row.payload) })),
    questions: questions.map((row) => ({
      type: row.type,
      id: row.id,
      document: parsePayload(row.payload),
    })),
  };
  const assembled = assembleContentPacks(documents, validateContentPack);
  if (!assembled.some(({ id }) => id === "default")) {
    throw new Error("D1 content is missing the default pack.");
  }
  const written = exportContentFiles(options.directory, documents, { force: options.force });
  await formatContentDirectory(resolve(options.directory));
  console.log(`Target: ${targetName(options)} (${DATABASE})`);
  console.log(
    `Exported ${written.packs} pack(s), ${written.rules} rules document(s), ${written.questions} question(s) to ${resolve(options.directory)}.`,
  );
}

async function list(options) {
  const packs = await selectRows("SELECT id, payload, updated_at FROM packs ORDER BY id", options);
  const rules = await selectRows("SELECT COUNT(*) AS count FROM rules", options);
  const questions = await selectRows(
    "SELECT type, COUNT(*) AS count FROM questions GROUP BY type ORDER BY type",
    options,
  );
  console.log(`Target: ${targetName(options)} (${DATABASE})`);
  if (packs.length === 0) {
    console.log("  no content packs stored");
    return;
  }
  for (const row of packs) {
    const document = parsePayload(row.payload);
    console.log(
      `  pack ${row.id}@${document.version} (updated ${formatTimestamp(row.updated_at)})`,
    );
  }
  const counts = questions.map((row) => `${row.type}=${row.count}`).join(" ") || "none";
  console.log(`  questions: ${counts}`);
  console.log(`  rules: ${rules[0]?.count ?? 0}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "push") await push(options);
  else if (options.command === "pull") await pull(options);
  else await list(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
