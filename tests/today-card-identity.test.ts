// Prevent decision navigation from guessing task identity from titles or execution numbers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stateOf } from "../kernel/state.ts";
import { empty, type Row } from "../kernel/evolve.ts";
import { readFileSync } from "node:fs";

test("owner state exposes the card's recorded task identity, not the newest run", () => {
  const cards = [
    { id: 66, task_id: 42, run_id: 118 },
    { id: 67, run_id: 45 },
  ];
  const view = empty();
  const schema = readFileSync(new URL("../kernel/schema.sql", import.meta.url), "utf8");
  for (const [, table, body] of schema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
    const columns = [...body.matchAll(/^  (\w+) (?:INTEGER|TEXT)/gm)].map(
      ([, column]) => `json_extract(data,'$.${column}') AS ${column}`,
    );
    view.db.exec(`CREATE VIEW ${table} AS SELECT ${columns.join(",")} FROM projections WHERE collection='${table}'`);
  }
  const insert = view.db.prepare("INSERT INTO projections(collection,key,data) VALUES('cards',?,?)");
  for (const card of cards) insert.run(String(card.id), JSON.stringify({ ...card, state: "open" }));
  const all = <T>(sql: string, params: import("node:sqlite").SQLInputValue[] = []) =>
    view.db.prepare(sql).all(...params) as T[];
  const state = stateOf(
    0,
    undefined,
    {
      timezone: "UTC",
      sources: {},
      agents: {},
      channels: {},
      rules: [],
      elsewhere: [],
    } as never,
    { all, view: (card: Row) => ({ id: card.id }) as never, unrouted: () => [] },
  );
  assert.equal((state.cards.find((card) => card.id === 66) as unknown as { taskId: number }).taskId, 42);
  assert.equal((state.cards.find((card) => card.id === 67) as unknown as { taskId: null }).taskId, null);
  view.close();
});
