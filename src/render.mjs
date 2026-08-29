// Turning an invoice into something you can send.
//
// Four formats, one shared model. `json` is the machine one; `md` is for
// pasting into an email or a repo; `txt` is for a terminal; `html` is the one
// a client sees, and it is deliberately a single self-contained file with no
// external stylesheet, font or image, so it survives being emailed as an
// attachment and prints to PDF from any browser.
import { formatMoney, toMajor } from "./money.mjs";
import { effectiveStatus } from "./invoices.mjs";

const escapeHtml = (text) => String(text ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/** "29 August 2026" - unambiguous in every country, unlike 08/29/2026. */
export function longDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

const qty = (n) => (Number.isInteger(n) ? String(n) : String(n));

/** Everything a rendered invoice needs, resolved once for all four formats. */
export function model(invoice, { business, client, now = new Date() } = {}) {
  const cur = invoice.currency;
  return {
    number: invoice.number,
    status: effectiveStatus(invoice, now),
    issuedAt: invoice.issuedAt,
    dueAt: invoice.dueAt,
    poNumber: invoice.poNumber,
    notes: invoice.notes,
    currency: cur,
    from: {
      name: business?.name || "",
      email: business?.email || "",
      address: business?.address || "",
    },
    to: {
      name: client?.displayName || invoice.clientName || "",
      email: client?.email || "",
      address: client?.address || "",
    },
    items: invoice.items.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      unitPrice: i.unitPrice,
      unitPriceText: formatMoney(i.unitPrice, cur),
      amount: i.amount,
      amountText: formatMoney(i.amount, cur),
      timerIds: i.timerIds || [],
    })),
    subtotal: invoice.subtotal,
    subtotalText: formatMoney(invoice.subtotal, cur),
    taxRate: invoice.taxRate,
    taxLabel: invoice.taxLabel || "Tax",
    tax: invoice.tax,
    taxText: formatMoney(invoice.tax, cur),
    total: invoice.total,
    totalText: formatMoney(invoice.total, cur),
    amountPaid: invoice.amountPaid || 0,
    balance: invoice.total - (invoice.amountPaid || 0),
    balanceText: formatMoney(invoice.total - (invoice.amountPaid || 0), cur),
    paymentInstructions: business?.paymentInstructions || "",
    footer: business?.footer || "",
  };
}

export function toJson(m) {
  return JSON.stringify({
    ...m,
    amounts: {
      subtotal: toMajor(m.subtotal, m.currency),
      tax: toMajor(m.tax, m.currency),
      total: toMajor(m.total, m.currency),
      balance: toMajor(m.balance, m.currency),
    },
  }, null, 2);
}

export function toMarkdown(m) {
  const lines = [];
  lines.push(`# Invoice ${m.number}`, "");
  if (m.from.name) lines.push(`**From:** ${m.from.name}${m.from.email ? ` <${m.from.email}>` : ""}`);
  if (m.from.address) lines.push(...m.from.address.split("\n").map((l) => `> ${l}`));
  lines.push("");
  lines.push(`**To:** ${m.to.name}${m.to.email ? ` <${m.to.email}>` : ""}`);
  if (m.to.address) lines.push(...m.to.address.split("\n").map((l) => `> ${l}`));
  lines.push("");
  lines.push(`**Issued:** ${longDate(m.issuedAt)}`);
  if (m.dueAt) lines.push(`**Due:** ${longDate(m.dueAt)}`);
  if (m.poNumber) lines.push(`**PO:** ${m.poNumber}`);
  lines.push("");
  lines.push("| Description | Qty | Rate | Amount |", "| --- | ---: | ---: | ---: |");
  for (const i of m.items) {
    lines.push(`| ${i.description.replace(/\|/g, "\\|")} | ${qty(i.quantity)}${i.unit ? ` ${i.unit}` : ""} | ${i.unitPriceText} | ${i.amountText} |`);
  }
  lines.push("");
  lines.push(`**Subtotal:** ${m.subtotalText}`);
  if (m.tax) lines.push(`**${m.taxLabel} (${m.taxRate}%):** ${m.taxText}`);
  lines.push(`**Total:** ${m.totalText}`);
  if (m.amountPaid) lines.push(`**Paid:** ${formatMoney(m.amountPaid, m.currency)}`, `**Balance due:** ${m.balanceText}`);
  if (m.paymentInstructions) lines.push("", "## Payment", "", m.paymentInstructions);
  if (m.notes) lines.push("", "## Notes", "", m.notes);
  if (m.footer) lines.push("", "---", "", m.footer);
  return `${lines.join("\n")}\n`;
}

export function toText(m) {
  const width = 62;
  const rule = "-".repeat(width);
  const out = [];
  out.push(`INVOICE ${m.number}`.toUpperCase(), rule);
  if (m.from.name) out.push(`From: ${m.from.name}${m.from.email ? ` <${m.from.email}>` : ""}`);
  for (const l of (m.from.address || "").split("\n").filter(Boolean)) out.push(`      ${l}`);
  out.push(`To:   ${m.to.name}${m.to.email ? ` <${m.to.email}>` : ""}`);
  for (const l of (m.to.address || "").split("\n").filter(Boolean)) out.push(`      ${l}`);
  out.push(`Issued: ${longDate(m.issuedAt)}${m.dueAt ? `    Due: ${longDate(m.dueAt)}` : ""}`);
  if (m.poNumber) out.push(`PO: ${m.poNumber}`);
  out.push(rule);
  const amountCol = Math.max(10, ...m.items.map((i) => i.amountText.length));
  for (const i of m.items) {
    const meta = `${qty(i.quantity)}${i.unit ? ` ${i.unit}` : ""} @ ${i.unitPriceText}`;
    out.push(i.description);
    out.push(`  ${meta.padEnd(width - amountCol - 2)}${i.amountText.padStart(amountCol)}`);
  }
  out.push(rule);
  const total = (label, value) => `${label.padEnd(width - amountCol)}${value.padStart(amountCol)}`;
  out.push(total("Subtotal", m.subtotalText));
  if (m.tax) out.push(total(`${m.taxLabel} (${m.taxRate}%)`, m.taxText));
  out.push(total("TOTAL", m.totalText));
  if (m.amountPaid) {
    out.push(total("Paid", formatMoney(m.amountPaid, m.currency)));
    out.push(total("BALANCE DUE", m.balanceText));
  }
  if (m.paymentInstructions) out.push("", "Payment", m.paymentInstructions);
  if (m.notes) out.push("", "Notes", m.notes);
  if (m.footer) out.push("", m.footer);
  return `${out.join("\n")}\n`;
}

/**
 * A single self-contained HTML file.
 *
 * No external anything: a client's mail app, an offline laptop and a browser's
 * print-to-PDF all have to render this identically, and every one of those
 * breaks the moment a stylesheet or a webfont has to be fetched. The print
 * rules exist because the most common thing anyone does with this file is
 * press Cmd-P.
 */
export function toHtml(m) {
  const row = (i) => `      <tr>
        <td>${escapeHtml(i.description)}</td>
        <td class="num">${escapeHtml(qty(i.quantity))}${i.unit ? ` ${escapeHtml(i.unit)}` : ""}</td>
        <td class="num">${escapeHtml(i.unitPriceText)}</td>
        <td class="num">${escapeHtml(i.amountText)}</td>
      </tr>`;
  const block = (text) => escapeHtml(text).split("\n").join("<br>");
  const totals = [
    `<tr><th>Subtotal</th><td class="num">${escapeHtml(m.subtotalText)}</td></tr>`,
    m.tax ? `<tr><th>${escapeHtml(m.taxLabel)} (${escapeHtml(m.taxRate)}%)</th><td class="num">${escapeHtml(m.taxText)}</td></tr>` : "",
    `<tr class="grand"><th>Total</th><td class="num">${escapeHtml(m.totalText)}</td></tr>`,
    m.amountPaid ? `<tr><th>Paid</th><td class="num">${escapeHtml(formatMoney(m.amountPaid, m.currency))}</td></tr>` : "",
    m.amountPaid ? `<tr class="grand"><th>Balance due</th><td class="num">${escapeHtml(m.balanceText)}</td></tr>` : "",
  ].filter(Boolean).join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice ${escapeHtml(m.number)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 32px; background: #f6f6f4; color: #1a1a1a;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .sheet { max-width: 760px; margin: 0 auto; background: #fff; padding: 48px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 28px; letter-spacing: -.02em; }
  .meta { text-align: right; font-size: 14px; color: #555; }
  .meta strong { color: #1a1a1a; }
  .status { display: inline-block; margin-top: 8px; padding: 2px 10px; border-radius: 999px; font-size: 12px;
    text-transform: uppercase; letter-spacing: .06em; background: #eee; color: #444; }
  .status.paid { background: #e3f5e6; color: #1b6b2c; }
  .status.overdue { background: #fdeaea; color: #a11; }
  .status.sent { background: #e8effb; color: #24518f; }
  .parties { display: flex; gap: 48px; flex-wrap: wrap; margin: 40px 0 32px; }
  .parties section { flex: 1 1 220px; }
  .parties h2 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #888; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  .items th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #888;
    border-bottom: 1px solid #ddd; padding: 0 0 8px; font-weight: 600; }
  .items td { padding: 12px 0; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .totals { margin-left: auto; width: min(320px, 100%); margin-top: 24px; }
  .totals th { text-align: left; font-weight: 400; color: #555; padding: 6px 0; }
  .totals td { padding: 6px 0; }
  .totals .grand th, .totals .grand td { font-weight: 700; font-size: 18px; border-top: 2px solid #1a1a1a; padding-top: 12px; color: #1a1a1a; }
  .note { margin-top: 40px; padding-top: 24px; border-top: 1px solid #eee; font-size: 14px; color: #444; }
  .note h2 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #888; font-weight: 600; }
  footer { margin-top: 32px; font-size: 12px; color: #888; }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { box-shadow: none; padding: 0; max-width: none; }
    tr { break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="sheet">
    <header>
      <div>
        <h1>Invoice ${escapeHtml(m.number)}</h1>
        <div class="status ${escapeHtml(m.status)}">${escapeHtml(m.status)}</div>
      </div>
      <div class="meta">
        <div>Issued <strong>${escapeHtml(longDate(m.issuedAt))}</strong></div>
        ${m.dueAt ? `<div>Due <strong>${escapeHtml(longDate(m.dueAt))}</strong></div>` : ""}
        ${m.poNumber ? `<div>PO <strong>${escapeHtml(m.poNumber)}</strong></div>` : ""}
      </div>
    </header>

    <div class="parties">
      <section>
        <h2>From</h2>
        <div><strong>${escapeHtml(m.from.name)}</strong></div>
        ${m.from.address ? `<div>${block(m.from.address)}</div>` : ""}
        ${m.from.email ? `<div>${escapeHtml(m.from.email)}</div>` : ""}
      </section>
      <section>
        <h2>Bill to</h2>
        <div><strong>${escapeHtml(m.to.name)}</strong></div>
        ${m.to.address ? `<div>${block(m.to.address)}</div>` : ""}
        ${m.to.email ? `<div>${escapeHtml(m.to.email)}</div>` : ""}
      </section>
    </div>

    <table class="items">
      <thead>
        <tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>
${m.items.map(row).join("\n")}
      </tbody>
    </table>

    <table class="totals">
      ${totals}
    </table>

    ${m.paymentInstructions ? `<div class="note"><h2>Payment</h2><div>${block(m.paymentInstructions)}</div></div>` : ""}
    ${m.notes ? `<div class="note"><h2>Notes</h2><div>${block(m.notes)}</div></div>` : ""}
    ${m.footer ? `<footer>${block(m.footer)}</footer>` : ""}
  </div>
</body>
</html>
`;
}

export const FORMATS = ["md", "html", "txt", "json"];

export function render(invoice, { format = "md", business, client, now = new Date() } = {}) {
  const m = model(invoice, { business, client, now });
  switch (format) {
    case "md": case "markdown": return toMarkdown(m);
    case "html": return toHtml(m);
    case "txt": case "text": return toText(m);
    case "json": return toJson(m);
    default: throw new Error(`unknown format "${format}" (${FORMATS.join(", ")})`);
  }
}
