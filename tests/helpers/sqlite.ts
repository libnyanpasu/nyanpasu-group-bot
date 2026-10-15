import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import { schema } from "../../src/schema.js";

const migrationDirectory = new URL("../../migrations/", import.meta.url);

/** An in-memory SQLite database with every migration applied, behind a Drizzle proxy. */
export function createTestDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  for (const filename of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql"))) {
    sqlite.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
  const database = drizzle(
    async (
      query: string,
      params: unknown[],
      method: "run" | "all" | "values" | "get",
    ): Promise<{ rows: SQLOutputValue[][] }> => {
      const statement = sqlite.prepare(query);
      const values = params as SQLInputValue[];
      if (method === "run") {
        statement.run(...values);
        return { rows: [] };
      }
      if (method === "get") {
        const row = statement.get(...values);
        return { rows: row ? [Object.values(row)] : [] };
      }
      return { rows: statement.all(...values).map((row) => Object.values(row)) };
    },
    { schema },
  );
  return { database, close: () => sqlite.close() };
}
