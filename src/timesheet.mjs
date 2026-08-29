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
import { PERIOD_HOURS, chargeFor } from "./rates.mjs";

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
 * The unit a rate bills in, spelled for an invoice line.
 *
 * "agent-hours" rather than "hours", because that is the arithmetic the client
 * can check: 2 hours with 2 agents at $100/hour/agent is 4 agent-hours at $100,
 * and printing it as "2 hours @ $100 = $400" invites a query we would deserve.
 */
export function unitLabel(rate) {
  if (!rate) return "hours";
  const base = rate.per === "task" ? "tasks" : `${rate.per}s`;
  return rate.unit && rate.unit !== "flat" ? `${rate.unit}-${base}` : base;
}

/**
 * Roll entries up into invoice line items, priced by a rate.
 *
 * Each entry is charged on its own and the billable units are then summed,
 * never the other way round: the agent count varies between entries, and
 * averaging it would bill a two-agent afternoon at the four-agent rate.
 *
 * The quantity that comes out is in the rate's own billing units, so
 * `quantity x unitPrice` reproduces the line amount exactly. That is the
 * property that makes an invoice checkable by hand, and it is worth the one
 * rounding it costs.
 */
export function toLineItems(entries, { group = "task", rate, now = new Date() } = {}) {
  const label = LABEL[group];
  if (!label) throw new Error(`unknown grouping "${group}" (${GROUP_KEYS.join(", ")})`);
  if (!rate) throw new Error("line items need a rate");
  if (rate.per === "project") {
    throw new Error(
      "a project fee is not a function of tracked time - invoice it with"
      + " --item \"Project fee|1|<amount>\" and use the hours as evidence",
    );
  }

  const perHours = PERIOD_HOURS[rate.per] ?? 1;
  const buckets = new Map();
  for (const e of entries) {
    const charge = chargeFor({ seconds: entrySeconds(e, now), agents: e.agents ?? 1 }, rate);
    const units = rate.per === "task"
      ? charge.units
      : (charge.billedHours / perHours) * charge.units;
    const text = label(e);
    const bucket = buckets.get(text)
      || { description: text, units: 0, seconds: 0, agents: 1, timerIds: [], earliest: e.start };
    bucket.units += units;
    bucket.seconds += entrySeconds(e, now);
    bucket.agents = Math.max(bucket.agents, e.agents ?? 1);
    bucket.timerIds.push(e.id);
    if (e.start < bucket.earliest) bucket.earliest = e.start;
    buckets.set(text, bucket);
  }

  const rows = [...buckets.values()];
  // Chronological, so an invoice reads as the story of the period rather than
  // a ranking. `day` groupings need this and the others benefit from it.
  rows.sort((a, b) => (a.earliest < b.earliest ? -1
    : a.earliest > b.earliest ? 1
    : a.description.localeCompare(b.description)));

  const unit = unitLabel(rate);
  return rows.map((b) => ({
    description: b.description,
    quantity: Math.round(b.units * 100) / 100,
    unit,
    unitPrice: rate.minor,
    hours: hoursOf(b.seconds),
    agents: b.agents,
    timerIds: b.timerIds,
  }));
}
