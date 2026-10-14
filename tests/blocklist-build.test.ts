import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  mergeBlocklist,
  parseArguments,
  parseSourceFile,
  sheetColumns,
  unzip,
} from "../scripts/blocklist-build.mjs";
import { normalizeSpamText, validateBlocklist } from "../src/lib/spam.js";

/** Build a minimal ZIP archive; even-indexed files are deflated, odd ones stored. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, content], index) => {
    const raw = Buffer.from(content);
    const method = index % 2 === 0 ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

function workbook(): Buffer {
  return zip({
    "xl/workbook.xml":
      '<workbook><sheets><sheet name="other" sheetId="1" r:id="rId1"/><sheet r:id="rId2" name="sensitive_words" sheetId="2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    "xl/sharedStrings.xml": `<sst><si><t>header</t></si><si><r><t>${b64("fixture x").slice(0, 4)}</t></r><r><t>${b64("fixture x").slice(4)}</t></r></si><si><t>${b64("delete me")}</t></si></sst>`,
    "xl/worksheets/sheet1.xml": "<worksheet/>",
    "xl/worksheets/sheet2.xml": `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c></row>
      <row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>0</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>${b64("ban & phrase")}</t></is></c><c r="B3" t="s"><v>2</v></c></row>
      <row r="4"><c r="A4" t="s"><v>1</v></c><c r="B4"/></row>
    </sheetData></worksheet>`,
  });
}

describe("blocklist sources", () => {
  it("reads stored and deflated ZIP entries", () => {
    const files = unzip(zip({ "a.txt": "deflated", "b.txt": "stored" }));
    expect(files.get("a.txt")?.toString()).toBe("deflated");
    expect(files.get("b.txt")?.toString()).toBe("stored");
    expect(() => unzip(Buffer.from("not a zip at all, definitely not"))).toThrow(/ZIP/);
  });

  it("reads a named worksheet through relationships and shared strings", () => {
    const columns = sheetColumns(unzip(workbook()), "sensitive_words");
    expect(columns.get("A")?.map(({ row }) => row)).toEqual([1, 2, 3, 4]);
    expect(() => sheetColumns(unzip(workbook()), "missing")).toThrow(/missing/);
  });

  it("decodes xiaomao workbooks below the header rows and line lists", () => {
    const file = {
      format: "xiaomao-xlsx",
      sheet: "sensitive_words",
      columns: { A: "ban", B: "delete" },
    };
    expect(parseSourceFile(file, workbook())).toEqual([
      { text: "ban & phrase", tier: "ban" },
      { text: "fixture x", tier: "ban" },
      { text: "delete me", tier: "delete" },
    ]);
    expect(
      parseSourceFile(
        { format: "lines", tier: "ban" },
        Buffer.from("# comment\r\n first \n\nsecond\n"),
      ),
    ).toEqual([
      { text: "first", tier: "ban" },
      { text: "second", tier: "ban" },
    ]);
    expect(() => parseSourceFile({ format: "csv" }, Buffer.alloc(0))).toThrow(/format/);
  });
});

describe("mergeBlocklist", () => {
  const merge = (
    entries: { text: string; tier: "ban" | "delete" }[],
    overrides: Parameters<typeof mergeBlocklist>[0]["overrides"] = {},
  ) =>
    mergeBlocklist({
      entries: entries.map((entry) => ({ ...entry, source: "fixture" })),
      overrides,
      normalize: normalizeSpamText,
      validate: validateBlocklist,
      version: "test",
    });

  it("deduplicates after normalization and keeps the stronger tier", () => {
    const { document, report } = merge([
      { text: "日入过万", tier: "delete" },
      { text: "日 入 过 万！", tier: "ban" },
      { text: "Ｗork From Home", tier: "delete" },
      { text: "work-from-home", tier: "delete" },
    ]);
    expect(document).toEqual({ version: "test", ban: ["日入过万"], delete: ["Ｗork From Home"] });
    expect(report.duplicates).toBe(2);
  });

  it("drops entries covered by a shorter entry of the same or a stronger tier", () => {
    const { document, report } = merge([
      { text: "乱伦", tier: "delete" },
      { text: "乱伦小说", tier: "delete" },
      { text: "乱伦群", tier: "ban" },
      { text: "=乱伦", tier: "delete" },
      { text: "日入", tier: "ban" },
      { text: "=日入", tier: "ban" },
    ]);
    // A delete-tier "乱伦" cannot stand in for the ban-tier "乱伦群".
    expect(document.ban).toEqual(["乱伦群", "日入"]);
    expect(document.delete).toEqual(["乱伦"]);
    expect(report.redundant.sort()).toEqual(["=乱伦", "=日入", "乱伦小说"].sort());
  });

  it("applies drops, demotions, local additions, validity and safe samples", () => {
    const { document, report } = merge(
      [
        { text: "政治词", tier: "delete" },
        { text: "长期招人", tier: "ban" },
        { text: "加微", tier: "delete" },
        { text: "肏", tier: "delete" },
        { text: "=加我", tier: "ban" },
      ],
      {
        drop: { "out of scope": ["政 治 词"] },
        delete: ["长期招人"],
        add: { ban: { 分类: ["本地词条"] }, delete: [] },
        safeSamples: ["增加微软的规则", "加我"],
      },
    );
    expect(document).toEqual({ version: "test", ban: ["本地词条"], delete: ["长期招人"] });
    expect(report).toMatchObject({
      read: 6,
      overridden: ["政治词"],
      invalid: ["肏"],
      unsafe: ["加微", "=加我"],
    });
  });
});

describe("parseArguments", () => {
  it("parses options and rejects unknown ones", () => {
    expect(parseArguments(["--dir", "x", "--version", "v1", "--dry-run"])).toEqual({
      directory: "x",
      version: "v1",
      dryRun: true,
    });
    expect(parseArguments([]).directory).toBe("private-content");
    expect(() => parseArguments(["--dir"])).toThrow(/requires/);
    expect(() => parseArguments(["--force"])).toThrow(/Unknown/);
  });
});
