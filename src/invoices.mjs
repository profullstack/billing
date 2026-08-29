// Invoices: line items, arithmetic, numbering and status.
//
// The arithmetic rule that matters: every amount is an integer in the
// currency's minor units, and rounding happens once per line. A client
// checking the column by hand must find that the printed lines add up to the
// printed subtotal, which they will not if you round only at the end.
import { applyRate, lineAmount } from "./money.mjs";
import { newId } from "./store.mjs";

export const STATUSES = ["draft", "sent", "paid", "void"];

/**
 * Statuses an invoice may move to, and from where.
 *
 * `void` is reachable from anywhere and is the only way to retire an invoice
 * that has already gone out. It is not the same as deleting: a voided invoice
 * keeps its number (so the sequence has no holes a bookkeeper has to explain)
 * but releases the hours it covered back to `--from-timer`.
 */
const TRANSITIONS = {
  draft: ["sent", "paid", "void"],
  sent: ["paid", "draft", "void"],
  paid: ["sent", "void"],
  void: ["draft"],
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

/** "INV-0007". Padding keeps invoices sorting correctly as plain strings. */
export function formatNumber(prefix, counter, pad = 4) {
  const body = String(counter).padStart(pad, "0");
  return prefix ? `${prefix}-${body}` : body;
}

/**
 * The next free number.
 *
 * Derived from the highest number in use, not only from the counter, so a
 * hand-edited ledger or an imported invoice cannot cause a collision. The
 * counter is still advanced, so numbers keep climbing after a deletion rather
 * than being reused.
 */
export function nextNumber(store) {
  const prefix = store.business.invoicePrefix || "";
  const used = new Set(store.invoices.map((i) => i.number));
  let counter = Math.max(store.counter || 0, 0);
  for (const inv of store.invoices) {
    const tail = /(\d+)\s*$/.exec(inv.number || "");
    if (tail) counter = Math.max(counter, Number(tail[1]));
  }
  let candidate;
  do {
    counter += 1;
    candidate = formatNumber(prefix, counter);
  } while (used.has(candidate));
  return { number: candidate, counter };
}

export function makeItem({ description, quantity = 1, unit = "hours", unitPrice = 0, timerIds = [] }) {
  const text = String(description || "").trim();
  if (!text) throw new Error("a line item needs a description");
  const qty = Number(quantity);
  if (!Number.isFinite(qty)) throw new Error(`line item "${text}" has a quantity that is not a number`);
  return {
    id: newId(6),
    description: text,
    quantity: qty,
    unit: String(unit || ""),
    unitPrice: Math.round(Number(unitPrice) || 0),
    timerIds: [...timerIds],
  };
}

export function makeInvoice({
  client,
  number,
  currency = "USD",
  taxRate = 0,
  taxLabel = "Tax",
  items = [],
  issuedAt = new Date().toISOString(),
  dueAt = null,
  notes = "",
  poNumber = "",
}) {
  if (!client) throw new Error("an invoice needs a client");
  const invoice = {
    id: newId(),
    number,
    clientId: client.id,
    clientName: client.displayName || client.name,
    status: "draft",
    currency: String(currency).toUpperCase(),
    taxRate: Number(taxRate) || 0,
    taxLabel: taxLabel || "Tax",
    issuedAt,
    dueAt,
    sentAt: null,
    paidAt: null,
    poNumber: String(poNumber || ""),
    notes: String(notes || ""),
    items: items.map(makeItem),
    amountPaid: 0,
    subtotal: 0,
    tax: 0,
    total: 0,
  };
  return recompute(invoice);
}

/** Recalculate the money on an invoice. Always called after any edit. */
export function recompute(invoice) {
  let subtotal = 0;
  for (const item of invoice.items) {
    item.amount = lineAmount(item.quantity, item.unitPrice);
    subtotal += item.amount;
  }
  invoice.subtotal = subtotal;
  invoice.tax = applyRate(subtotal, invoice.taxRate || 0);
  invoice.total = invoice.subtotal + invoice.tax;
  invoice.balance = invoice.total - (invoice.amountPaid || 0);
  return invoice;
}

export function findInvoice(store, ref) {
  const want = String(ref || "").trim().toLowerCase();
  if (!want) return null;
  return store.invoices.find((i) => i.number.toLowerCase() === want)
    || store.invoices.find((i) => i.id === want)
    // A bare "7" should find INV-0007: nobody types the padding.
    || store.invoices.find((i) => {
      const tail = /(\d+)\s*$/.exec(i.number || "");
      return tail && /^\d+$/.test(want) && Number(tail[1]) === Number(want);
    })
    || null;
}

/**
 * Every timer entry id already spoken for.
 *
 * Voided invoices are excluded on purpose: voiding is how you release hours
 * that were billed by mistake so they can go on the next invoice instead.
 */
export function billedEntryIds(store, { exceptInvoiceId = null } = {}) {
  const ids = new Set();
  for (const inv of store.invoices) {
    if (inv.status === "void") continue;
    if (exceptInvoiceId && inv.id === exceptInvoiceId) continue;
    for (const item of inv.items) for (const id of item.timerIds || []) ids.add(id);
  }
  return ids;
}

export function isOverdue(invoice, now = new Date()) {
  if (invoice.status !== "sent" || !invoice.dueAt) return false;
  return new Date(invoice.dueAt).getTime() < now.getTime();
}

/** Where an invoice actually stands, which is more than its stored status. */
export function effectiveStatus(invoice, now = new Date()) {
  return isOverdue(invoice, now) ? "overdue" : invoice.status;
}

/** Due date from terms in days. Null terms means no due date at all. */
export function dueFrom(issuedAt, termsDays) {
  if (termsDays == null || termsDays === "") return null;
  const days = Number(termsDays);
  if (!Number.isFinite(days)) throw new Error(`payment terms must be a number of days, got "${termsDays}"`);
  return new Date(new Date(issuedAt).getTime() + days * 86400000).toISOString();
}

/** Money owed across a set of invoices, and what has been collected. */
export function summarize(invoices, now = new Date()) {
  const out = {
    invoices: invoices.length,
    billed: 0,
    collected: 0,
    outstanding: 0,
    overdue: 0,
    draft: 0,
    byStatus: { draft: 0, sent: 0, paid: 0, void: 0, overdue: 0 },
  };
  for (const inv of invoices) {
    out.byStatus[effectiveStatus(inv, now)] += 1;
    if (inv.status === "void") continue;
    if (inv.status === "draft") { out.draft += inv.total; continue; }
    out.billed += inv.total;
    out.collected += inv.amountPaid || 0;
    const owed = inv.total - (inv.amountPaid || 0);
    if (owed > 0) {
      out.outstanding += owed;
      if (isOverdue(inv, now)) out.overdue += owed;
    }
  }
  return out;
}
