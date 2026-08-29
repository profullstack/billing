import assert from "node:assert/strict";
import test from "node:test";

import {
  billedEntryIds,
  canTransition,
  dueFrom,
  effectiveStatus,
  findInvoice,
  formatNumber,
  makeInvoice,
  nextNumber,
  recompute,
  summarize,
} from "../src/invoices.mjs";
import { emptyStore } from "../src/store.mjs";

const client = { id: "c1", name: "acme", displayName: "Acme Corp" };
const invoice = (over = {}) => makeInvoice({
  client,
  number: "INV-0001",
  currency: "USD",
  items: [{ description: "work", quantity: 2, unitPrice: 15000 }],
  ...over,
});

test("an invoice computes its own totals", () => {
  const inv = invoice();
  assert.equal(inv.subtotal, 30000);
  assert.equal(inv.tax, 0);
  assert.equal(inv.total, 30000);
});

test("tax is applied to the subtotal and rounded to the minor unit", () => {
  const inv = invoice({ taxRate: 8.25 });
  assert.equal(inv.tax, 2475);
  assert.equal(inv.total, 32475);
});

test("line amounts sum exactly to the subtotal", () => {
  const inv = invoice({
    items: [
      { description: "a", quantity: 0.33, unitPrice: 10000 },
      { description: "b", quantity: 0.33, unitPrice: 10000 },
      { description: "c", quantity: 0.33, unitPrice: 10000 },
    ],
  });
  assert.equal(inv.items.reduce((n, i) => n + i.amount, 0), inv.subtotal);
  assert.equal(inv.subtotal, 9900);
});

test("a line item without a description is refused", () => {
  assert.throws(() => invoice({ items: [{ description: "  ", quantity: 1, unitPrice: 100 }] }), /needs a description/);
});

test("numbers are zero-padded so they sort as strings", () => {
  assert.equal(formatNumber("INV", 7), "INV-0007");
  assert.equal(formatNumber("INV", 1234), "INV-1234");
  assert.equal(formatNumber("", 7), "0007");
  assert.ok("INV-0002" > "INV-0001");
});

test("nextNumber never collides, even with a hand-edited ledger", () => {
  const store = emptyStore();
  store.business.invoicePrefix = "INV";
  // A ledger where someone pasted in an invoice numbered far ahead of the
  // counter. Trusting the counter alone would reissue a number already in use.
  store.invoices = [{ number: "INV-0009", items: [] }];
  store.counter = 1;
  const next = nextNumber(store);
  assert.equal(next.number, "INV-0010");
  assert.equal(next.counter, 10);
});

test("findInvoice accepts the full number, the id, or a bare digit", () => {
  const store = emptyStore();
  const inv = invoice();
  store.invoices = [inv];
  assert.equal(findInvoice(store, "INV-0001")?.number, "INV-0001");
  assert.equal(findInvoice(store, "inv-0001")?.number, "INV-0001");
  assert.equal(findInvoice(store, "1")?.number, "INV-0001");
  assert.equal(findInvoice(store, inv.id)?.number, "INV-0001");
  assert.equal(findInvoice(store, "99"), null);
});

test("status transitions allow the sensible moves and refuse the rest", () => {
  assert.ok(canTransition("draft", "sent"));
  assert.ok(canTransition("sent", "paid"));
  assert.ok(canTransition("paid", "void"), "a settled invoice can still be voided");
  assert.equal(canTransition("void", "paid"), false, "a voided invoice cannot be paid");
  assert.equal(canTransition("draft", "nonsense"), false);
});

test("a voided invoice releases the hours it covered", () => {
  const store = emptyStore();
  const live = invoice({ items: [{ description: "a", quantity: 1, unitPrice: 100, timerIds: ["e1", "e2"] }] });
  const dead = invoice({ number: "INV-0002", items: [{ description: "b", quantity: 1, unitPrice: 100, timerIds: ["e3"] }] });
  dead.status = "void";
  store.invoices = [live, dead];
  const billed = billedEntryIds(store);
  assert.deepEqual([...billed].sort(), ["e1", "e2"]);
});

test("billedEntryIds can exclude the invoice being edited", () => {
  const store = emptyStore();
  const inv = invoice({ items: [{ description: "a", quantity: 1, unitPrice: 100, timerIds: ["e1"] }] });
  store.invoices = [inv];
  assert.equal(billedEntryIds(store).size, 1);
  assert.equal(billedEntryIds(store, { exceptInvoiceId: inv.id }).size, 0);
});

test("dueFrom adds days, and no terms means no due date", () => {
  assert.equal(dueFrom("2026-08-01T00:00:00.000Z", 14), "2026-08-15T00:00:00.000Z");
  assert.equal(dueFrom("2026-08-01T00:00:00.000Z", null), null);
  assert.throws(() => dueFrom("2026-08-01T00:00:00.000Z", "soon"), /number of days/);
});

test("overdue is derived, not stored", () => {
  const inv = invoice({ dueAt: "2026-08-01T00:00:00.000Z" });
  inv.status = "sent";
  const after = new Date("2026-08-10T00:00:00.000Z");
  assert.equal(effectiveStatus(inv, after), "overdue");
  assert.equal(effectiveStatus(inv, new Date("2026-07-01T00:00:00.000Z")), "sent");
  inv.status = "paid";
  assert.equal(effectiveStatus(inv, after), "paid", "a paid invoice is never overdue");
});

test("summarize keeps drafts out of what is owed", () => {
  const draft = invoice();
  const sent = invoice({ number: "INV-0002" });
  sent.status = "sent";
  const paid = invoice({ number: "INV-0003" });
  paid.status = "paid";
  paid.amountPaid = paid.total;
  const money = summarize([draft, sent, paid]);
  assert.equal(money.draft, 30000, "a draft is not money anybody owes yet");
  assert.equal(money.billed, 60000);
  assert.equal(money.collected, 30000);
  assert.equal(money.outstanding, 30000);
});

test("a part payment leaves a balance outstanding", () => {
  const inv = invoice();
  inv.status = "sent";
  inv.amountPaid = 10000;
  recompute(inv);
  assert.equal(inv.balance, 20000);
  assert.equal(summarize([inv]).outstanding, 20000);
});
