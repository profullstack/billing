import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { emptyStore, read, update, withLock, write } from "../src/store.mjs";
import { scratch } from "./helpers.mjs";

test("a missing ledger reads as an empty one", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  assert.deepEqual(read(s.file), emptyStore());
});

test("a corrupt ledger is an error, never a silent reset", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  fs.writeFileSync(s.file, "{not json");
  assert.throws(() => read(s.file), /not valid JSON/);
});

test("a ledger from a newer schema says so instead of dropping fields", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  fs.writeFileSync(s.file, JSON.stringify({ version: 99, clients: [], invoices: [] }));
  assert.throws(() => read(s.file), /newer billing/);
});

test("a partial ledger is filled in with defaults rather than crashing", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  fs.writeFileSync(s.file, JSON.stringify({ version: 1, business: { name: "Only a name" } }));
  const store = read(s.file);
  assert.equal(store.business.name, "Only a name");
  assert.equal(store.business.currency, "USD", "a missing field falls back to the default");
  assert.deepEqual(store.clients, []);
  assert.deepEqual(store.invoices, []);
});

test("write is atomic and leaves no temp files behind", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  write({ ...emptyStore(), counter: 3 }, s.file);
  assert.deepEqual(fs.readdirSync(s.dir), ["ledger.json"]);
  assert.equal(read(s.file).counter, 3);
});

test("the lock is released even when the mutation throws", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  assert.throws(() => update(() => { throw new Error("boom"); }, { file: s.file }), /boom/);
  assert.equal(fs.existsSync(`${s.file}.lock`), false);
});

test("a held lock blocks a second writer, so a number cannot be issued twice", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  withLock(() => {
    assert.throws(() => withLock(() => {}, { file: s.file, timeoutMs: 60 }), /holding/);
  }, { file: s.file });
});

test("a stale lock is reclaimed instead of wedging the ledger forever", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  fs.mkdirSync(`${s.file}.lock`, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${s.file}.lock`, old, old);
  assert.equal(withLock(() => true, { file: s.file, timeoutMs: 200, staleMs: 1000 }), true);
});
