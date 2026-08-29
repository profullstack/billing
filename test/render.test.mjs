import assert from "node:assert/strict";
import test from "node:test";

import { makeInvoice } from "../src/invoices.mjs";
import { longDate, model, render } from "../src/render.mjs";

const business = {
  name: "Test Co", email: "billing@test.co", address: "1 Test Way\nAustin, TX",
  paymentInstructions: "ACH on request", footer: "Thank you", taxLabel: "VAT",
};
const client = { id: "c1", name: "acme", displayName: "Acme & Sons <Ltd>", email: "ap@acme.com", address: "2 Acme Rd" };

const invoice = (over = {}) => makeInvoice({
  client,
  number: "INV-0001",
  currency: "USD",
  taxRate: 8.25,
  taxLabel: "VAT",
  issuedAt: "2026-08-29T00:00:00.000Z",
  dueAt: "2026-09-12T00:00:00.000Z",
  items: [{ description: "auth refactor", quantity: 5.5, unitPrice: 17500 }],
  ...over,
});

test("dates are spelled out so no country reads them backwards", () => {
  assert.equal(longDate("2026-08-29T00:00:00.000Z"), "29 August 2026");
});

test("every format renders and carries the total", () => {
  for (const format of ["md", "html", "txt", "json"]) {
    const out = render(invoice(), { format, business, client });
    assert.ok(out.length > 100, `${format} produced nothing`);
    assert.match(out, /1,041\.91|1041\.91/, `${format} is missing the total`);
  }
});

test("an unknown format is refused by name", () => {
  assert.throws(() => render(invoice(), { format: "pdf", business, client }), /unknown format "pdf"/);
});

test("the HTML is a single self-contained file", () => {
  const html = render(invoice(), { format: "html", business, client });
  assert.match(html, /^<!doctype html>/);
  assert.equal(/https?:\/\//.test(html), false, "no external stylesheet, font or image may be fetched");
  assert.match(html, /<style>/, "styles are inline");
  assert.match(html, /@media print/, "it has to survive print-to-PDF");
});

test("HTML escapes client-supplied text rather than rendering it as markup", () => {
  const html = render(invoice({ notes: '<script>alert(1)</script>' }), { format: "html", business, client });
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Acme &amp; Sons &lt;Ltd&gt;/, "the client name is escaped too");
});

test("markdown escapes a pipe so it cannot break the table", () => {
  const md = render(invoice({ items: [{ description: "a | b", quantity: 1, unitPrice: 100 }] }), {
    format: "md", business, client,
  });
  assert.match(md, /a \\\| b/);
});

test("a part payment shows both the payment and the balance", () => {
  const inv = invoice();
  inv.amountPaid = 50000;
  for (const format of ["md", "txt"]) {
    const out = render(inv, { format, business, client });
    assert.match(out, /Balance due|BALANCE DUE/i, `${format} hides the balance`);
  }
});

test("no tax means no tax line", () => {
  const md = render(invoice({ taxRate: 0 }), { format: "md", business, client });
  assert.equal(md.includes("VAT"), false);
});

test("the model exposes amounts in both minor units and major", () => {
  const m = model(invoice(), { business, client });
  assert.equal(m.subtotal, 96250);
  assert.equal(m.totalText, "$1,041.91");
  assert.equal(JSON.parse(render(invoice(), { format: "json", business, client })).amounts.total, 1041.91);
});
