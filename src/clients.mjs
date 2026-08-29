// Clients: who you bill, and on what terms.
//
// A client is looked up by a short handle ("acme"), not by an id, because that
// handle is what you type on every command and what appears in `--project`
// filters. Ids exist so a rename does not orphan the invoices.
import { newId } from "./store.mjs";
import { parseRate } from "./rates.mjs";

export function makeClient({
  name,
  displayName = "",
  email = "",
  address = "",
  rate = null,
  currency = null,
  taxRate = null,
  terms = null,
  projects = [],
  notes = "",
}) {
  const handle = normalizeHandle(name);
  if (!handle) throw new Error("a client needs a name");
  return {
    id: newId(),
    name: handle,
    displayName: displayName || String(name),
    email: String(email || ""),
    address: String(address || ""),
    rate: rate == null ? null : coerceRate(rate, currency ? String(currency).toUpperCase() : "USD"),
    currency: currency ? String(currency).toUpperCase() : null,
    taxRate: taxRate == null ? null : Number(taxRate),
    terms: terms == null ? null : Number(terms),
    projects: normalizeProjects(projects),
    notes: String(notes || ""),
    archived: false,
  };
}

/** Handles are lower-case and space-free so `--client Acme Corp` cannot split. */
export function normalizeHandle(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, "-");
}

export function normalizeProjects(projects) {
  return [...new Set([projects].flat().filter(Boolean).map((p) => String(p).trim()).filter(Boolean))];
}

export function findClient(store, name) {
  const handle = normalizeHandle(name);
  if (!handle) return null;
  return store.clients.find((c) => c.name === handle)
    || store.clients.find((c) => c.id === String(name))
    || store.clients.find((c) => c.displayName.toLowerCase() === String(name).trim().toLowerCase())
    || null;
}

/**
 * The timer projects that belong to a client.
 *
 * Defaulting to the client's own handle is what makes the common case need no
 * configuration at all: `timer start acme` and `billing client add acme` line
 * up without anyone being told they have to.
 */
export function projectsFor(client) {
  return client.projects.length ? client.projects : [client.name];
}

/**
 * Read a rate however it was written.
 *
 * Three spellings reach this: a full sentence ("$100/hour/agent/upto:4"), a
 * bare number from `--rate 150`, and an already-parsed object read back off
 * disk. A bare number is an hourly rate in the client's currency, which is what
 * somebody typing `--rate 150` means every time.
 */
export function coerceRate(value, currency = "USD") {
  if (value == null || value === "") return null;
  if (typeof value === "object") return value.minor != null ? value : null;
  const text = String(value).trim();
  const spec = /^[0-9.]+$/.test(text) ? `${text} ${currency}/hour` : text;
  return parseRate(spec);
}

/** Terms resolve client → business → the built-in 14 days. */
export function resolve(client, business) {
  const currency = client.currency || business.currency || "USD";
  const rateSource = client.rate != null ? client.rate : business.rate;
  const rate = coerceRate(rateSource, currency);
  return {
    // The rate carries its own currency, and it wins: a client billed
    // "0.5 SOL/day" is invoiced in SOL whatever the default says.
    currency: rate?.currency || currency,
    rate,
    taxRate: client.taxRate != null ? client.taxRate : (business.taxRate || 0),
    terms: client.terms != null ? client.terms : (business.terms ?? 14),
  };
}
