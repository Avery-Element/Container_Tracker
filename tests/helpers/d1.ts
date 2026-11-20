import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** A database with every migration in migrations/ applied, in order. */
export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort())
    db.exec(readFileSync(`migrations/${f}`, "utf8"));
  return db;
}

/** Minimal D1 stand-in backed by node:sqlite. batch() is atomic, like D1's. */
export function fakeD1(db: DatabaseSync): D1Database {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: ReturnType<typeof stmt>[]) => {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}
