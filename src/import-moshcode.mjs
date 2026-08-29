// Bringing across a ledger that started life inside moshcode.
//
// moshcode kept the same records in two files of its own - ~/.moshcode/
// business.json (clients, rates, invoices) and timers.json (the entries). This
// reads them and returns what they would be here, without writing anything:
// the caller decides, so `--dry-run` can show the whole migration before it
// happens.
//
// Nothing is destroyed at the source. A migration that deletes the thing it
// migrated has no way back if the mapping turns out to be wrong, and these
// files are small enough that leaving them costs nothing.
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { coerceRate, makeClient, normalizeProjects } from "./clients.mjs";
import { makeInvoice } from "./invoices.mjs";
import { fromMajor } from "./money.mjs";

export function moshcodeDir() {
  return process.env.MOSHCODE_STATE_DIR || path.join(homedir(), ".moshcode");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`${file} is not readable as JSON: ${err.message}`);
  }
}

/**
 * Read moshcode's business layer.
 *
 * Returns `{ found: false }` rather than throwing when there is nothing there,
 * because "you have no moshcode data" is the normal answer on most machines
 * and is not an error worth an exit code.
 */
export function readMoshcode({ dir = moshcodeDir() } = {}) {
  const businessFile = path.join(dir, "business.json");
  const timersFile = path.join(dir, "timers.json");
  const business = readJson(businessFile);
  const timers = readJson(timersFile);
  return {
    found: Boolean(business || timers),
    dir,
    businessFile,
    timersFile,
    business: business || {},
    timers: timers || {},
  };
}

/**
 * Map moshcode's records onto this ledger's shapes.
 *
 * Two joins are worth naming. moshcode files rates in a separate `rates` map
 * keyed by client id, where here a rate lives on the client, so the map is
 * folded in as it is read. And moshcode marks a timer entry `billed` with the
 * invoice that claimed it, where here the invoice carries the entry ids - so
 * the claim is read off the entries and written onto the invoices, which is the
 * same fact stored from the other end.
 */
export function planImport(source, existing) {
  const clients = [];
  const invoices = [];
  const notes = [];
  const rates = source.business.rates || {};
  const byOldId = new Map();

  for (const [id, raw] of Object.entries(source.business.clients || {})) {
    const name = raw.name || raw.id || id;
    if (existing.clients.some((c) => c.name === String(name).trim().toLowerCase().replace(/\s+/g, "-"))) {
      notes.push(`client "${name}" already exists here - left alone`);
      continue;
    }
    let rate = null;
    try {
      rate = rates[id] ? coerceRate(rates[id].spec || rates[id], raw.currency || "USD") : null;
    } catch {
      notes.push(`client "${name}" had a rate this version cannot read - import it by hand`);
    }
    const client = makeClient({
      name,
      displayName: raw.display || raw.name || String(name),
      email: raw.email || raw.contact?.email || "",
      address: raw.address || raw.contact?.address || "",
      rate,
      currency: raw.currency || null,
      projects: normalizeProjects(raw.projects || []),
      notes: raw.notes || "",
    });
    byOldId.set(id, client);
    clients.push(client);
  }

  // Which entries each old invoice claimed, read off the entries themselves.
  const claimed = new Map();
  for (const entry of source.timers.entries || []) {
    if (!entry.billed) continue;
    const key = String(entry.invoice || entry.billed);
    if (!claimed.has(key)) claimed.set(key, []);
    claimed.get(key).push(entry.id);
  }

  for (const [id, raw] of Object.entries(source.business.invoices || {})) {
    const client = byOldId.get(raw.client) || clients.find((c) => c.name === raw.client) || null;
    if (!client) {
      notes.push(`invoice ${raw.number || id} refers to a client that did not come across - skipped`);
      continue;
    }
    const currency = raw.currency || client.currency || "USD";
    const invoice = makeInvoice({
      client,
      number: raw.number || id,
      currency,
      taxRate: raw.taxRate || 0,
      issuedAt: raw.issuedAt || raw.created || new Date().toISOString(),
      dueAt: raw.dueAt || null,
      notes: raw.notes || "",
      items: (raw.lines || []).map((line) => ({
        description: line.what || line.description || "work",
        quantity: line.units ?? line.quantity ?? 1,
        unit: line.unit || "hours",
        unitPrice: fromMajor(line.unitPrice ?? 0, currency),
        timerIds: line.entries || [],
      })),
    });
    if (!invoice.items.length) {
      // An invoice with no lines cannot be recreated faithfully, and a blank
      // one carrying a real number is worse than a note saying so.
      notes.push(`invoice ${invoice.number} had no line items - skipped`);
      continue;
    }
    const extra = claimed.get(id) || claimed.get(invoice.number) || [];
    if (extra.length && !invoice.items.some((i) => i.timerIds.length)) {
      invoice.items[0].timerIds = extra;
    }
    if (raw.status && ["draft", "sent", "paid", "void"].includes(raw.status)) invoice.status = raw.status;
    if (raw.paidAt) { invoice.paidAt = raw.paidAt; invoice.amountPaid = invoice.total; }
    invoices.push(invoice);
  }

  return { clients, invoices, notes };
}

/** moshcode's timer entries, in the shape @profullstack/timer writes. */
export function planTimesheet(source, existingIds = new Set()) {
  const entries = [];
  let skipped = 0;
  for (const raw of source.timers.entries || []) {
    if (existingIds.has(raw.id)) { skipped += 1; continue; }
    const start = raw.start || raw.at || null;
    if (!start) { skipped += 1; continue; }
    const seconds = Number(raw.seconds) || 0;
    entries.push({
      id: raw.id,
      project: raw.client || raw.project || "unassigned",
      task: raw.task || raw.note || "",
      tags: raw.tags || [],
      start,
      end: raw.end || new Date(new Date(start).getTime() + seconds * 1000).toISOString(),
      notes: raw.note || "",
      agent: raw.agent || null,
      agents: Math.max(1, Number(raw.agents) || 1),
      rate: null,
      billable: raw.billable !== false,
      meta: {},
    });
  }
  return { entries, skipped };
}
