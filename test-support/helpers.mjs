import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';

class D1Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new D1Statement(this.db, this.sql, params); }
  run() { const result = this.db.prepare(this.sql).run(...this.params); return { meta: { changes: result.changes } }; }
  first() { return this.db.prepare(this.sql).get(...this.params) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
}
export function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    DB: {
      raw: db,
      prepare(sql) { return new D1Statement(db, sql); },
      async batch(items) {
        db.exec('BEGIN');
        try { const results = items.map(item => item.run()); db.exec('COMMIT'); return results; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }
    },
    ASSETS: { fetch: () => new Response('index') }
  };
}
export async function call(env, path, method = 'GET', data) {
  const request = new Request(`https://example.test${path}`, {
    method,
    ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  });
  const result = await worker.fetch(request, env);
  return { status: result.status, data: await result.json() };
}

