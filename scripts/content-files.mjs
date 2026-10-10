import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative, basename } from "node:path";
import Ajv from "ajv";

/**
 * @typedef {object} ContentDocuments
 * @property {{ id: string, document: import("../src/types.js").PackDocument }[]} packs
 * @property {{ id: string, document: import("../src/types.js").RulesDocument }[]} rules
 * @property {{ type: string, id: string, document: import("../src/types.js").Question }[]} questions
 */

const schemaRoot = fileURLToPath(new URL("../schemas/", import.meta.url));
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(
  ["question", "rules", "pack"].map((name) => [
    name,
    ajv.compile(JSON.parse(readFileSync(resolve(schemaRoot, `${name}.schema.json`), "utf8"))),
  ]),
);
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(root, path, reason) {
  throw new Error(
    `Private content ${relative(root, path) || "."}: ${reason}. Contents are omitted.`,
  );
}

function requirePath(root, path, directory = false) {
  if (!existsSync(path)) fail(root, path, "missing path");
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    fail(
      root,
      path,
      directory ? "expected a real directory, no symlinks" : "expected a regular file, no symlinks",
    );
  }
}

function jsonFiles(root, directory) {
  requirePath(root, directory, true);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = resolve(directory, name);
      requirePath(root, path);
      const id = basename(name, ".json");
      if (!slug.test(id) || id.length > 64)
        fail(root, path, "filename must be a stable lowercase ID");
      return path;
    });
}

function readDocument(root, path, kind) {
  requirePath(root, path);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(root, path, "invalid JSON");
  }
  const validate = validators[kind];
  if (!validate(value)) {
    const location = validate.errors?.[0]?.instancePath || "/";
    // Do not serialize validator errors: they may contain private field values.
    fail(root, path, `invalid ${kind} document at ${location}`);
  }
  const { $schema: _schema, ...document } = value;
  return document;
}

/**
 * Read and validate a content checkout into document form, mirroring the
 * on-disk layout: pack manifests plus the rules and question documents they
 * reference.
 *
 * @param {string} source
 * @param {boolean} required
 * @returns {ContentDocuments}
 */
export function readContentDocuments(source, required) {
  const empty = { packs: [], rules: [], questions: [] };
  const root = resolve(source);
  const packDirectory = resolve(root, "packs");
  if (!existsSync(root)) {
    if (required) throw new Error("Private content directory is missing.");
    return empty;
  }
  requirePath(root, root, true);
  if (existsSync(resolve(root, "content.json"))) {
    fail(
      root,
      resolve(root, "content.json"),
      "legacy format must be migrated to packs, rules and questions directories",
    );
  }
  if (!existsSync(packDirectory)) {
    if (required) throw new Error("Private content directory is missing pack documents.");
    return empty;
  }
  const files = jsonFiles(root, packDirectory);
  if (files.length === 0 || files.length > 50) fail(root, packDirectory, "expected 1–50 packs");
  requirePath(root, resolve(root, "rules"), true);
  requirePath(root, resolve(root, "questions"), true);

  const packs = [];
  const rulesById = new Map();
  const questionsByKey = new Map();
  for (const path of files) {
    const manifest = readDocument(root, path, "pack");
    if (manifest.id !== basename(path, ".json")) fail(root, path, "pack ID must match filename");
    packs.push({ id: manifest.id, document: manifest });
    if (!rulesById.has(manifest.rules)) {
      rulesById.set(
        manifest.rules,
        readDocument(root, resolve(root, "rules", `${manifest.rules}.json`), "rules"),
      );
    }
    for (const type of [...manifest.questionTypes].sort()) {
      const directory = resolve(root, "questions", type);
      const questionFiles = jsonFiles(root, directory);
      if (!questionFiles.length) fail(root, directory, "question type must not be empty");
      for (const file of questionFiles) {
        const question = readDocument(root, file, "question");
        if (question.id !== basename(file, ".json"))
          fail(root, file, "question ID must match filename");
        const key = `${type}/${question.id}`;
        if (!questionsByKey.has(key))
          questionsByKey.set(key, { type, id: question.id, document: question });
      }
    }
  }
  return {
    packs,
    rules: [...rulesById].map(([id, document]) => ({ id, document })),
    questions: [...questionsByKey.values()],
  };
}

/**
 * Assemble and validate content packs from documents.
 *
 * @param {ContentDocuments} documents
 * @param {(pack: unknown) => string | null} validateContentPack
 * @returns {import("../src/types.js").ContentPack[]}
 */
export function assembleContentPacks(documents, validateContentPack) {
  const rulesById = new Map(documents.rules.map((entry) => [entry.id, entry.document]));
  const questionsByType = new Map();
  for (const entry of documents.questions) {
    const list = questionsByType.get(entry.type) ?? [];
    list.push(entry.document);
    questionsByType.set(entry.type, list);
  }
  return documents.packs.map(({ id, document: manifest }) => {
    const rules = rulesById.get(manifest.rules);
    if (!rules) throw new Error(`Content pack ${id}: missing rules document.`);
    const questions = [...manifest.questionTypes]
      .sort()
      .flatMap((type) => questionsByType.get(type) ?? []);
    const pack = { id, version: manifest.version, questions, rules };
    if (validateContentPack(pack))
      throw new Error(
        `Content pack ${id}: invalid assembled pack, check unique question IDs and localized message lengths.`,
      );
    return pack;
  });
}

/**
 * Load, assemble and validate content documents from a checkout directory.
 *
 * @param {string} source
 * @param {boolean} required
 * @param {(pack: unknown) => string | null} validateContentPack
 * @returns {import("../src/types.js").ContentPack[]}
 */
export function loadContent(source, required, validateContentPack) {
  const packs = assembleContentPacks(readContentDocuments(source, required), validateContentPack);
  if (packs.length > 0 && !packs.some((pack) => pack.id === "default")) {
    throw new Error("Private content must include the default pack.");
  }
  return packs;
}
