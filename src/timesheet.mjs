// The bridge to @profullstack/timer.
//
// Read-only, by design. Billing never writes to the timesheet: the record of
// what an invoice covers lives on the invoice, as a list of entry ids. That
// keeps one fact in one place, so deleting an invoice makes those hours
// billable again with nothing to un-mark and no way for the two files to
// disagree.
import fs from "node:fs";

import { timerDataFile } from "./paths.mjs";
import { localDay } from "./time.mjs";

/**
 * Load the timesheet. A missing one is not an error here: it means "no tracked
 * hours", which is a perfectly good answer to `--from-timer` on a machine
 * where timer was never used.
 */
export function readTimesheet(file = timerDataFile()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { file, found: false, entries: [] };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`the timesheet at ${file} is not valid JSON`);
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return { file, found: true, entries };
}

/** Seconds on an entry. A running entry is measured to now, but see below. */
export function entrySeconds(entry, now = new Date()) {
  const start = new Date(entry.start).getTime();
  const end = entry.end ? new Date(entry.end).getTime() : now.getTime();
  return Math.max(0, Math.round((end - start) / 1000));
}

export const hoursOf = (seconds) => Math.round((seconds / 3600) * 100) / 100;

/**
 * The entries a client's next invoice would cover.
 *
 * Four filters, and the reasoning behind two of them is the whole story:
 *
 *   - the client's projects (see clients.projectsFor)
 *   - the window, on the entry's start, with --until exclusive: the same rule
 *     timer uses, so the two tools agree about which day an entry belongs to
 *   - billable only, and finished only. A running clock is deliberately left
 *     out: its duration is still changing, and an invoice line that would have
 *     been different a minute later is not a line you can send.
 *   - not already billed. `billedIds` comes from the ledger's own invoices.
 */
export function selectBillable(entries, {
  projects = [],
  since = null,
  until = null,
  billedIds = new Set(),
  includeRunning = false,
} = {}) {
  const wanted = new Set(projects.map((p) => String(p).toLowerCase()));
  const kept = [];
  const skipped = { running: 0, unbillable: 0, alreadyBilled: 0 };
  for (const e of entries) {
    if (wanted.size && !wanted.has(String(e.project || "").toLowerCase())) continue;
    if (since && e.start < since) continue;
    if (until && e.start >= until) continue;
    if (e.billable === false) { skipped.unbillable += 1; continue; }
    if (!e.end) {
      skipped.running += 1;
      if (!includeRunning) continue;
    }
    if (billedIds.has(e.id)) { skipped.alreadyBilled += 1; continue; }
    kept.push(e);
  }
  return { entries: kept, skipped };
}

const LABEL = {
  task: (e) => e.task || e.project || "(no task)",
  project: (e) => e.project || "(no project)",
  day: (e) => localDay(e.start),
  tag: (e) => (e.tags?.length ? e.tags[0] : "(untagged)"),
  entry: (e) => `${e.task || e.project || "(no task)"} (${localDay(e.start)})`,
};

export const GROUP_KEYS = Object.keys(LABEL);

/**
 * Roll entries up into invoice line items.
 *
 * Rate is part of the grouping key, not just the label. Two entries on the
 * same task at different rates are two lines, because collapsing them would
 * mean inventing a blended rate that appears nowhere in the record and that
 * the client cannot check.
 */
export function toLineItems(entries, {
  group = "task",
  defaultRate = 0,
  rateOf = null,
  now = new Date(),
} = {}) {
  const label = LABEL[group];
  if (!label) throw new Error(`unknown grouping "${group}" (${GROUP_KEYS.join(", ")})`);
  const buckets = new Map();
  for (const e of entries) {
    const rate = rateOf ? rateOf(e) : defaultRate;
    const text = label(e);
    const key = `${text} ${rate}`;
    const bucket = buckets.get(key)
      || { description: text, unitPrice: rate, seconds: 0, timerIds: [], earliest: e.start };
    bucket.seconds += entrySeconds(e, now);
    bucket.timerIds.push(e.id);
    if (e.start < bucket.earliest) bucket.earliest = e.start;
    buckets.set(key, bucket);
  }
  const rows = [...buckets.values()];
  // Chronological, so an invoice reads as the story of the period rather than
  // a ranking. `day` groupings need this and the others benefit from it.
  rows.sort((a, b) => (a.earliest < b.earliest ? -1
    : a.earliest > b.earliest ? 1
    : a.description.localeCompare(b.description)));
  return rows.map((b) => ({
    description: b.description,
    quantity: hoursOf(b.seconds),
    unit: "hours",
    unitPrice: b.unitPrice,
    timerIds: b.timerIds,
  }));
}
