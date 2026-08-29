// What an hour of agent time costs, written the way people say it out loud.
//
//   billing rate set acme '$100/hour/agent/upto:4'
//
// One line carrying four decisions: the price, the period it is charged for,
// the thing that is multiplied (an agent, a seat, a person), and the point past
// which you stop charging. Rate cards get written down as prose in a contract
// and then re-derived by hand at invoice time; this makes the prose itself the
// machine-readable form, so an invoice does the arithmetic from the same words
// the client agreed to.
//
// Settlement currency is deliberately separate from the price. "$100/hour paid
// in USDC" is one rate with a preference, not two rates - the number in the
// contract does not change because the rail did.
import { formatMoney, isFiat, minorDigits, parsePrice, toMajor } from "./money.mjs";

/** Periods a rate can be charged per. `project` and `task` are flat fees. */
export const PERIODS = ["hour", "day", "week", "month", "project", "task"];

/** What gets multiplied. `flat` means the price is not per-anything. */
export const UNITS = ["agent", "seat", "person", "team", "flat"];

/** Hours in each period, for converting tracked time into billable units. */
export const PERIOD_HOURS = { hour: 1, day: 8, week: 40, month: 160 };

/** Words that are categories rather than tickers, and stay lowercase. */
const SETTLEMENT_WORDS = new Set(["fiat", "crypto", "stablecoin", "any", "cash"]);

/**
 * Parse a rate spec into `{ minor, currency, per, unit, cap, min }`, or throw.
 *
 * The grammar is positional only in its first segment (the price); everything
 * after it is recognised by what it says rather than where it sits, so
 * `$100/agent/hour` and `$100/hour/agent` mean the same thing. People do not
 * remember an order they were never told.
 */
export function parseRate(spec) {
  const text = String(spec ?? "").trim();
  if (!text) throw new Error("a rate looks like $100/hour/agent/upto:4");
  const parts = text.split("/").map((p) => p.trim()).filter(Boolean);
  const price = parsePrice(parts.shift());
  if (!price) throw new Error(`can't read a price out of ${JSON.stringify(text)} - try $100/hour/agent`);

  const rate = {
    minor: price.minor, currency: price.currency,
    per: "hour", unit: "flat", cap: null, min: null, prefer: [], accept: [],
  };
  let sawPeriod = false;
  for (const part of parts) {
    const [key, value] = part.split(":").map((s) => s.trim().toLowerCase());
    if (["upto", "up-to", "max", "cap"].includes(key)) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`upto: wants a whole number of units, got ${JSON.stringify(value ?? "")}`);
      rate.cap = n;
      continue;
    }
    if (["min", "minimum", "floor"].includes(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`min: wants a number, got ${JSON.stringify(value ?? "")}`);
      rate.min = n;
      continue;
    }
    const word = key.replace(/s$/, "");
    if (PERIODS.includes(word)) { rate.per = word; sawPeriod = true; continue; }
    if (word === "hr") { rate.per = "hour"; sawPeriod = true; continue; }
    if (word === "mo") { rate.per = "month"; sawPeriod = true; continue; }
    if (word === "yr" || word === "year") {
      // A yearly figure is carried as a monthly one so every period shares one
      // conversion path. Rounding the integer here keeps the arithmetic exact.
      rate.per = "month";
      rate.minor = Math.round(rate.minor / 12);
      sawPeriod = true;
      continue;
    }
    if (UNITS.includes(word)) { rate.unit = word; continue; }
    if (word === "head" || word === "dev" || word === "engineer") { rate.unit = "person"; continue; }
    throw new Error(`don't know what ${JSON.stringify(part)} means in a rate - periods: ${PERIODS.join("/")}, units: ${UNITS.join("/")}, or upto:N`);
  }
  // A flat fee with no period stated is a project fee, not an hourly one:
  // "$5000 for the project" is how it is written, and defaulting it to per-hour
  // would silently multiply the invoice by every hour tracked.
  if (!sawPeriod && rate.unit === "flat" && rate.cap === null) rate.per = "hour";
  if (rate.cap !== null && rate.unit === "flat") {
    throw new Error("upto: caps a unit, so say what it caps - $100/hour/agent/upto:4");
  }
  return rate;
}

/** The canonical spelling of a parsed rate. Round-trips through parseRate. */
export function formatRate(rate) {
  if (!rate) return "-";
  const bits = [formatMoney(rate.minor, rate.currency), rate.per];
  if (rate.unit && rate.unit !== "flat") bits.push(rate.unit);
  if (rate.cap) bits.push(`upto:${rate.cap}`);
  if (rate.min) bits.push(`min:${rate.min}`);
  return bits.join("/");
}

/** "prefers SOL or USDC, fiat accepted" - or "" when nothing was stated. */
export function settlementNote(rate) {
  const prefer = rate?.prefer || [];
  const accept = rate?.accept || [];
  const bits = [];
  if (prefer.length) bits.push(`prefers ${prefer.join(" or ")}`);
  if (accept.length) bits.push(`${accept.join(", ")} accepted`);
  return bits.join(", ");
}

/** How a rate reads in a sentence, for confirmations and invoices. */
export function describeRate(rate) {
  if (!rate) return "no rate set";
  const price = formatMoney(rate.minor, rate.currency);
  const unit = rate.unit && rate.unit !== "flat" ? ` per ${rate.unit}` : "";
  const cap = rate.cap ? `, billing at most ${rate.cap} ${rate.unit}${rate.cap === 1 ? "" : "s"}` : "";
  const settle = settlementNote(rate);
  return `${price} per ${rate.per}${unit}${cap}${settle ? ` (${settle})` : ""}`;
}

/** Normalise a `--prefer sol,usdc` list: tickers upper, categories lower. */
export function normalizeSettlement(list) {
  return [list].flat().filter(Boolean)
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (SETTLEMENT_WORDS.has(s.toLowerCase()) ? s.toLowerCase() : s.toUpperCase()));
}

/**
 * What one tracked entry costs under a rate.
 *
 * Charged per entry and then summed, never summed and then charged: the agent
 * count varies between entries, and an average would quietly bill a two-agent
 * afternoon at the four-agent rate (or the other way round, which is worse for
 * a different reason).
 *
 * `amount` is null for a project fee - a fee for the whole job is not a
 * function of any single entry, and inventing a per-entry share of it would put
 * a number on the invoice that nobody agreed to.
 */
export function chargeFor({ seconds = 0, agents = 1 } = {}, rate) {
  if (!rate) return null;
  const currency = rate.currency || "USD";
  const hours = seconds / 3600;
  if (rate.per === "project") {
    return { hours, billedHours: hours, units: 1, amount: null, currency, flat: true, per: rate.per };
  }
  const units = rate.unit === "flat"
    ? 1
    : Math.max(1, Math.min(Number(agents) || 1, rate.cap ?? Infinity));
  if (rate.per === "task") {
    return { hours, billedHours: hours, units, amount: rate.minor * units, currency, flat: false, per: rate.per };
  }
  const perHours = PERIOD_HOURS[rate.per] ?? 1;
  let billedHours = hours;
  if (rate.min) billedHours = Math.max(billedHours, rate.min * perHours);
  const periods = billedHours / perHours;
  return {
    hours,
    billedHours,
    units,
    // One rounding, at the entry, so entries sum to the line and lines sum to
    // the subtotal.
    amount: Math.round(rate.minor * periods * units),
    currency,
    flat: false,
    per: rate.per,
  };
}

/** A rate as JSON: minor units for arithmetic, major for anything human. */
export function serializeRate(rate) {
  if (!rate) return null;
  return {
    ...rate,
    amount: toMajor(rate.minor, rate.currency),
    text: formatRate(rate),
    describes: describeRate(rate),
    fiat: isFiat(rate.currency),
    digits: minorDigits(rate.currency),
  };
}
