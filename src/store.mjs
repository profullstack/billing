// Reading and writing the ledger.
//
// Same two guarantees as the timesheet in @profullstack/timer, and for a
// sharper reason: this file holds invoice numbers. A torn write or an
// interleaved read-modify-write could issue the same number twice, and a
// duplicate invoice number is the kind of mistake a client's accounts
// department notices. So: tmp-file + rename for atomicity, and a mkdir lock
// (the one atomic primitive every filesystem here has) around read-modify-write.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { dataFile } from "./paths.mjs";

export const SCHEMA_VERSION = 1;

/** The defaults a ledger starts with, before `billing init` names a business. */
export function emptyStore() {
  return {
    version: SCHEMA_VERSION,
    business: {
      name: "",
      email: "",
      address: "",
      currency: "USD",
      rate: null,
      taxRate: 0,
      taxLabel: "Tax",
      terms: 14,
      paymentInstructions: "",
      invoicePrefix: "INV",
      footer: "",
    },
    clients: [],
    invoices: [],
    counter: 0,
  };
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export function newId(len = 8) {
  let out = "";
  for (const b of randomBytes(len)) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export function read(file = dataFile()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return emptyStore();
    throw err;
  }
  if (!raw.trim()) return emptyStore();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `ledger at ${file} is not valid JSON. Move it aside to start fresh — it has not been touched.`,
    );
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`ledger at ${file} is not an object`);
  if (parsed.version > SCHEMA_VERSION) {
    throw new Error(
      `ledger at ${file} was written by a newer billing (schema ${parsed.version}); upgrade with: npm install -g @profullstack/billing`,
    );
  }
  const base = emptyStore();
  return {
    ...base,
    ...parsed,
    version: SCHEMA_VERSION,
    business: { ...base.business, ...(parsed.business || {}) },
    clients: Array.isArray(parsed.clients) ? parsed.clients : [],
    invoices: Array.isArray(parsed.invoices) ? parsed.invoices : [],
    counter: Number.isInteger(parsed.counter) ? parsed.counter : 0,
  };
}

export function write(store, file = dataFile()) {
  ensureDir(file);
  const tmp = `${file}.${process.pid}.${newId(4)}.tmp`;
  // 0600: a ledger carries client addresses and what you charge them. It is
  // not a secret store, but it is nobody else's business on a shared box.
  fs.writeFileSync(tmp, `${JSON.stringify({ ...store, version: SCHEMA_VERSION }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function withLock(fn, { file = dataFile(), timeoutMs = 5000, staleMs = 10_000 } = {}) {
  const lock = `${file}.lock`;
  ensureDir(file);
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > staleMs) {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* someone else won */ }
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`another billing process is holding ${lock}. If nothing else is running, remove that directory.`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* reclaimed as stale */ }
  }
}

export function update(fn, { file = dataFile() } = {}) {
  return withLock(() => {
    const store = read(file);
    const result = fn(store);
    write(store, file);
    return result;
  }, { file });
}
