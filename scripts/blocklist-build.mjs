import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { loadSpamModule } from "./content-cli.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const USAGE = `Usage: node scripts/blocklist-build.mjs [options]

Fetch the upstream word lists in blocklist/sources.json, apply blocklist/overrides.json,
then normalize, deduplicate and merge them into <dir>/blocklists/default.json.

Options:
  --dir <path>       Content checkout directory (default: private-content)
  --version <text>   Blocklist version (default: today's UTC date)
  --dry-run          Print the report without writing the blocklist`;

const TIER_RANK = { delete: 1, ban: 2 };

/**
 * Read every file of a ZIP archive (an .xlsx workbook) into memory. Only stored and
 * deflated entries are supported, which covers spreadsheets written by common tools.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
export function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("Not a ZIP archive.");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Corrupt ZIP directory.");
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
  }
  return files;
}

function unescapeXml(text) {
  return text.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (match, entity) => {
    const named = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[entity.toLowerCase()];
    if (named) return named;
    const code =
      entity[1] === "x" || entity[1] === "X"
        ? parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
  );
}

function texts(xml) {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map(([, text]) => unescapeXml(text))
    .join("");
}

/**
 * Read the cell strings of one worksheet, keyed by column letter and ordered by row.
 *
 * @param {Map<string, Buffer>} files Unzipped workbook
 * @param {string} sheetName
 * @returns {Map<string, { row: number, value: string }[]>}
 */
export function sheetColumns(files, sheetName) {
  const read = (name) => {
    const file = files.get(name);
    if (!file) throw new Error(`Workbook is missing ${name}.`);
    return file.toString("utf8");
  };
  const sheet = [...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)]
    .map(([tag]) => attributes(tag))
    .find((sheet) => sheet.name === sheetName);
  if (!sheet) throw new Error(`Workbook has no sheet named ${sheetName}.`);
  const relation = [...read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)]
    .map(([tag]) => attributes(tag))
    .find((relation) => relation.Id === sheet["r:id"]);
  if (!relation) throw new Error(`Workbook sheet ${sheetName} has no target.`);
  const target = relation.Target.startsWith("/")
    ? relation.Target.slice(1)
    : `xl/${relation.Target}`;
  const shared = files.has("xl/sharedStrings.xml")
    ? [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, item]) =>
        texts(item),
      )
    : [];

  const columns = new Map();
  for (const [, tag, body] of read(target).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const { r: reference, t: type } = attributes(tag);
    const position = /^([A-Z]+)(\d+)$/.exec(reference ?? "");
    if (!position || body === undefined) continue;
    const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
    let value;
    if (type === "s" && raw !== undefined) value = shared[Number(raw)];
    else if (type === "inlineStr") value = texts(body);
    else if (raw !== undefined) value = unescapeXml(raw);
    if (value === undefined || value === "") continue;
    const list = columns.get(position[1]) ?? [];
    list.push({ row: Number(position[2]), value });
    columns.set(position[1], list);
  }
  for (const list of columns.values()) list.sort((left, right) => left.row - right.row);
  return columns;
}

/**
 * Extract tiered entries from one source file.
 *
 * - `lines`: one entry per line; blank lines and `#` comments are skipped.
 * - `xiaomao-xlsx`: xiaomaoJT/TgBot's workbook, where each column below the two header
 *   rows holds base64-encoded words.
 *
 * @returns {{ text: string, tier: "ban" | "delete" }[]}
 */
export function parseSourceFile(file, body) {
  if (file.format === "lines") {
    return body
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((text) => ({ text, tier: file.tier }));
  }
  if (file.format === "xiaomao-xlsx") {
    const columns = sheetColumns(unzip(body), file.sheet);
    return Object.entries(file.columns).flatMap(([column, tier]) =>
      (columns.get(column) ?? [])
        .filter(({ row }) => row >= 3)
        .map(({ value }) => ({
          text: Buffer.from(value.trim(), "base64").toString("utf8").trim(),
          tier,
        })),
    );
  }
  throw new Error(`Unknown source format ${file.format}.`);
}

/**
 * Merge tiered entries into one blocklist document.
 *
 * Entries are compared after the Worker's normalization. The stronger tier wins for
 * duplicates, and an entry is redundant when a shorter entry of the same or a stronger
 * tier is contained in it, because substring matching already catches it.
 *
 * @param {object} input
 * @param {{ text: string, tier: "ban" | "delete", source: string }[]} input.entries
 * @param {{ drop?: Record<string, string[]>, delete?: string[], add?: Record<"ban" | "delete", string[] | Record<string, string[]>>, safeSamples?: string[] }} input.overrides
 * @param {(text: string) => string} input.normalize
 * @param {(document: unknown) => string | null} input.validate
 * @param {string} input.version
 */
export function mergeBlocklist({ entries, overrides, normalize, validate, version }) {
  const keyOf = (text) => normalize(text.startsWith("=") ? text.slice(1) : text);
  const dropped = new Set(
    Object.values(overrides.drop ?? {})
      .flat()
      .map(keyOf),
  );
  const demoted = new Set((overrides.delete ?? []).map(keyOf));
  const samples = (overrides.safeSamples ?? []).map(normalize);
  const report = { read: 0, overridden: [], invalid: [], unsafe: [], duplicates: 0, redundant: [] };

  const local = ["ban", "delete"].flatMap((tier) =>
    // Each tier is a list, or lists grouped by category for review.
    [overrides.add?.[tier] ?? []]
      .flatMap((group) => (Array.isArray(group) ? group : Object.values(group).flat()))
      .map((text) => ({ text, tier, source: "local" })),
  );
  const unique = new Map();
  for (const entry of [...entries, ...local]) {
    report.read += 1;
    const text = entry.text.trim();
    const exact = text.startsWith("=");
    const key = keyOf(text);
    if (dropped.has(key)) {
      report.overridden.push(text);
      continue;
    }
    if (validate({ version: "check", ban: [text], delete: [] })) {
      report.invalid.push(text);
      continue;
    }
    if (samples.some((sample) => (exact ? sample === key : sample.includes(key)))) {
      report.unsafe.push(text);
      continue;
    }
    const tier = entry.tier === "ban" && demoted.has(key) ? "delete" : entry.tier;
    const id = `${exact ? "=" : ""}${key}`;
    const previous = unique.get(id);
    if (previous) {
      report.duplicates += 1;
      if (TIER_RANK[tier] > TIER_RANK[previous.tier]) previous.tier = tier;
      continue;
    }
    unique.set(id, { text, key, exact, tier });
  }

  const kept = [...unique.values()];
  const substrings = kept.filter((entry) => !entry.exact);
  const document = { version, ban: [], delete: [] };
  for (const entry of kept) {
    const covered = substrings.some(
      (other) =>
        other !== entry &&
        TIER_RANK[other.tier] >= TIER_RANK[entry.tier] &&
        other.key.length < entry.key.length + (entry.exact ? 1 : 0) &&
        entry.key.includes(other.key),
    );
    if (covered) report.redundant.push(entry.text);
    else document[entry.tier].push(entry);
  }
  for (const tier of ["ban", "delete"]) {
    document[tier] = document[tier]
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .map(({ text }) => text);
  }
  const error = validate(document);
  if (error) throw new Error(`Merged blocklist is invalid: ${error}`);
  return { document, report };
}

export function parseArguments(argv) {
  const options = {
    directory: "private-content",
    version: new Date().toISOString().slice(0, 10),
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--dir" || argument === "--version") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${argument} requires a value.\n${USAGE}`);
      options[argument === "--dir" ? "directory" : "version"] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}\n${USAGE}`);
  }
  return options;
}

async function fetchSource(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Fetching ${url} failed with HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const readJson = (name) => JSON.parse(readFileSync(join(root, "blocklist", name), "utf8"));
  const { sources } = readJson("sources.json");
  const overrides = readJson("overrides.json");
  const { normalizeSpamText, validateBlocklist } = await loadSpamModule();

  const entries = [];
  for (const source of sources) {
    let count = 0;
    for (const file of source.files) {
      const parsed = parseSourceFile(file, await fetchSource(file.url));
      entries.push(...parsed.map((entry) => ({ ...entry, source: source.id })));
      count += parsed.length;
    }
    console.log(`  ${source.id}: ${count} entries (${source.license}) ${source.project}`);
  }
  const { document, report } = mergeBlocklist({
    entries,
    overrides,
    normalize: normalizeSpamText,
    validate: validateBlocklist,
    version: options.version,
  });

  console.log(`Read ${report.read} entries; ${report.duplicates} duplicates merged.`);
  const list = (label, items) => {
    if (items.length) console.log(`${label} (${items.length}): ${items.join(" | ")}`);
  };
  list("Dropped by overrides", report.overridden);
  list("Dropped as invalid (fewer than two letters or digits)", report.invalid);
  list("Dropped for matching a safe sample", report.unsafe);
  list("Covered by a shorter entry", report.redundant);
  console.log(
    `Result: ${document.ban.length} ban, ${document.delete.length} delete (version ${document.version}).`,
  );

  if (options.dryRun) return;
  const target = resolve(options.directory, "blocklists", "default.json");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify({ $schema: "../schemas/blocklist.schema.json", ...document }, null, 2)}\n`,
  );
  console.log(`Wrote ${target}. Review it, then run pnpm content:push.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
