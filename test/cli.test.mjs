import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cli, json, scratch, seeded, writeTimesheet } from "./helpers.mjs";

const AUGUST = [
  { id: "a", task: "auth refactor", start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T12:30:00.000Z" },
  { id: "b", task: "auth refactor", start: "2026-08-04T09:00:00.000Z", end: "2026-08-04T11:00:00.000Z" },
  { id: "c", task: "code review", start: "2026-08-05T14:00:00.000Z", end: "2026-08-05T15:15:00.000Z" },
  { id: "d", task: "standup", start: "2026-08-05T09:00:00.000Z", end: "2026-08-05T09:15:00.000Z", billable: false },
  { id: "e", project: "other", task: "misc", start: "2026-08-06T09:00:00.000Z", end: "2026-08-06T11:00:00.000Z" },
  { id: "f", task: "still going", start: "2026-08-07T09:00:00.000Z", end: null },
];
const WINDOW = ["--since", "2026-08-01", "--until", "2026-09-01"];

test("init stores the business and is idempotent field by field", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  cli(["init", "--name", "Test Co", "--rate", "150", "--terms", "30"], s);
  const after = json(["init", "--email", "hi@test.co"], s);
  assert.equal(after.data.business.name, "Test Co", "an unnamed field is left alone");
  assert.equal(after.data.business.email, "hi@test.co");
  assert.equal(after.data.business.terms, 30);
});

test("client add, list, set and show", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const added = json(["client", "add", "beta", "--display", "Beta LLC", "--rate", "200"], s);
  assert.equal(added.data.add.name, "beta");

  const list = json(["client", "list"], s);
  assert.deepEqual(list.data.clients.map((c) => c.name).sort(), ["acme", "beta"]);

  json(["client", "set", "beta", "--rate", "225", "--project", "beta-api", "--project", "beta-web"], s);
  const shown = json(["client", "show", "beta"], s);
  assert.equal(shown.data.resolved.rate.amount, 225, "a bare number is an hourly rate");
  assert.equal(shown.data.resolved.rate.per, "hour");
  assert.deepEqual(shown.data.projects, ["beta-api", "beta-web"]);
});

test("a client name with spaces becomes one handle", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const added = json(["client", "add", "Big Corp", "--rate", "100"], s);
  assert.equal(added.data.add.name, "big-corp");
  assert.equal(added.data.add.displayName, "Big Corp");
});

test("adding the same client twice is refused", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const again = cli(["client", "add", "acme"], s);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already exists/);
});

test("an unknown client names the ones that exist", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const res = cli(["hours", "--client", "nobody"], s);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /known: acme/);
});

test("hours previews exactly what --from-timer would bill", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s, { rate: "175" });
  writeTimesheet(s.timer, AUGUST);

  const preview = json(["hours", "--client", "acme", ...WINDOW], s);
  assert.equal(preview.data.hours, 6.75, "5.5h auth + 1.25h review");
  assert.equal(preview.data.subtotal, 1181.25);
  assert.equal(preview.data.skipped.running, 1);
  assert.equal(preview.data.skipped.unbillable, 1);
  assert.deepEqual(preview.data.items.map((i) => i.description), ["auth refactor", "code review"]);

  const created = json(["invoice", "new", "--client", "acme", "--from-timer", ...WINDOW], s);
  assert.equal(created.data.created.amounts.total, 1181.25, "the preview and the invoice agree");
});

test("the same hours cannot be billed twice", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s, { rate: "175" });
  writeTimesheet(s.timer, AUGUST);
  json(["invoice", "new", "--client", "acme", "--from-timer", ...WINDOW], s);

  const again = cli(["invoice", "new", "--client", "acme", "--from-timer", ...WINDOW], s);
  assert.equal(again.code, 3);
  assert.match(again.stderr, /already invoiced/);
  assert.equal(json(["hours", "--client", "acme", ...WINDOW], s).data.hours, 0);
});

test("voiding an invoice makes its hours billable again", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s, { rate: "175" });
  writeTimesheet(s.timer, AUGUST);
  const inv = json(["invoice", "new", "--client", "acme", "--from-timer", ...WINDOW], s).data.created;

  json(["invoice", "mark", inv.number, "void"], s);
  assert.equal(json(["hours", "--client", "acme", ...WINDOW], s).data.hours, 6.75);
});

test("deleting a draft invoice also frees its hours", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s, { rate: "175" });
  writeTimesheet(s.timer, AUGUST);
  const inv = json(["invoice", "new", "--client", "acme", "--from-timer", ...WINDOW], s).data.created;
  json(["invoice", "rm", inv.number], s);
  assert.equal(json(["hours", "--client", "acme", ...WINDOW], s).data.hours, 6.75);
});

test("--dry-run computes the invoice and writes nothing", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s, { rate: "175" });
  writeTimesheet(s.timer, AUGUST);
  const dry = json(["invoice", "new", "--client", "acme", "--from-timer", "--dry-run", ...WINDOW], s);
  assert.equal(dry.data.wouldCreate.amounts.total, 1181.25);
  assert.equal(json(["invoice", "list"], s).data.invoices.length, 0, "nothing was written");
  assert.equal(json(["hours", "--client", "acme", ...WINDOW], s).data.hours, 6.75, "the hours are still billable");
});

test("a dry run still validates, so it cannot preview an invoice that would be refused", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  cli(["init", "--name", "Test Co"], s);
  cli(["client", "add", "norate"], s);
  const res = cli(["invoice", "new", "--client", "norate", "--from-timer", "--dry-run"], s);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /no rate for/);
});

test("an entry's own rate beats the client rate", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s, { rate: "150" });
  writeTimesheet(s.timer, [
    { id: "a", task: "normal", start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T10:00:00.000Z" },
    { id: "b", task: "rush", start: "2026-08-04T09:00:00.000Z", end: "2026-08-04T10:00:00.000Z", rate: 300 },
  ]);
  const inv = json(["invoice", "new", "--client", "acme", "--from-timer", ...WINDOW], s).data.created;
  assert.equal(inv.amounts.total, 450, "1h at 150 plus 1h at 300");
});

test("--rate overrides the client rate for one invoice", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s, { rate: "150" });
  writeTimesheet(s.timer, [{ id: "a", task: "work", start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T11:00:00.000Z" }]);
  const inv = json(["invoice", "new", "--client", "acme", "--from-timer", "--rate", "250", ...WINDOW], s).data.created;
  assert.equal(inv.amounts.total, 500);
});

test("--group changes how the hours are described", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s, { rate: "100" });
  writeTimesheet(s.timer, AUGUST);
  const byDay = json(["invoice", "new", "--client", "acme", "--from-timer", "--group", "day", "--dry-run", ...WINDOW], s);
  assert.deepEqual(byDay.data.wouldCreate.items.map((i) => i.description), ["2026-08-03", "2026-08-04", "2026-08-05"]);
  assert.equal(cli(["invoice", "new", "--client", "acme", "--from-timer", "--group", "colour", ...WINDOW], s).code, 2);
});

test("fixed line items need no timesheet at all", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const inv = json(["invoice", "new", "--client", "acme", "--item", "August retainer|1|2500", "--item", "Rush fee|2|250"], s).data.created;
  assert.equal(inv.amounts.total, 3000);
  assert.equal(inv.items[0].unit, "", "a flat fee is not measured in hours");
});

test("a malformed --item says which part is wrong", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  assert.equal(cli(["invoice", "new", "--client", "acme", "--item", "just a description"], s).code, 2);
  assert.match(cli(["invoice", "new", "--client", "acme", "--item", "thing|1|free"], s).stderr, /is not an amount/);
});

test("an invoice with no line items is refused", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const res = cli(["invoice", "new", "--client", "acme"], s);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /needs line items/);
});

test("tax and terms come from the client, and flags override them", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  cli(["init", "--name", "Test Co", "--currency", "USD", "--terms", "14", "--tax", "0"], s);
  cli(["client", "add", "acme", "--rate", "100", "--tax", "8.25", "--terms", "30"], s);
  const inv = json(["invoice", "new", "--client", "acme", "--item", "work|1|1000", "--issued", "2026-08-01"], s).data.created;
  assert.equal(inv.taxRate, 8.25);
  assert.equal(inv.amounts.total, 1082.5);
  assert.equal(inv.dueAt.slice(0, 10), "2026-08-31", "net 30 from the issue date");

  const override = json(["invoice", "new", "--client", "acme", "--item", "work|1|1000", "--tax", "0", "--terms", "7", "--issued", "2026-08-01"], s).data.created;
  assert.equal(override.amounts.total, 1000);
  assert.equal(override.dueAt.slice(0, 10), "2026-08-08");
});

test("invoice numbers increment and never repeat", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const first = json(["invoice", "new", "--client", "acme", "--item", "a|1|100"], s).data.created;
  const second = json(["invoice", "new", "--client", "acme", "--item", "b|1|100"], s).data.created;
  assert.equal(first.number, "INV-0001");
  assert.equal(second.number, "INV-0002");
  json(["invoice", "rm", second.number], s);
  const third = json(["invoice", "new", "--client", "acme", "--item", "c|1|100"], s).data.created;
  assert.equal(third.number, "INV-0003", "a deleted number is not reused");
});

test("marking paid settles the balance; --amount records a part payment", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const inv = json(["invoice", "new", "--client", "acme", "--item", "work|1|1000"], s).data.created;
  json(["invoice", "mark", inv.number, "sent"], s);

  const part = json(["invoice", "mark", inv.number, "paid", "--amount", "400"], s).data.invoice;
  assert.equal(part.status, "sent", "a part payment does not make an invoice paid");
  assert.equal(part.amounts.balance, 600);

  const full = json(["invoice", "mark", inv.number, "paid"], s).data.invoice;
  assert.equal(full.status, "paid");
  assert.equal(full.amounts.balance, 0);
});

test("a voided invoice cannot be marked paid", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const inv = json(["invoice", "new", "--client", "acme", "--item", "work|1|1000"], s).data.created;
  json(["invoice", "mark", inv.number, "void"], s);
  const res = cli(["invoice", "mark", inv.number, "paid"], s);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /cannot move/);
});

test("overdue is derived from the due date", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const inv = json(["invoice", "new", "--client", "acme", "--item", "work|1|1000", "--issued", "2020-01-01", "--terms", "14"], s).data.created;
  json(["invoice", "mark", inv.number, "sent"], s);
  const listed = json(["invoice", "list", "--overdue"], s);
  assert.equal(listed.data.invoices.length, 1);
  assert.equal(listed.data.invoices[0].effectiveStatus, "overdue");
});

test("a sent or paid invoice is not deleted by accident", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const inv = json(["invoice", "new", "--client", "acme", "--item", "work|1|1000"], s).data.created;
  json(["invoice", "mark", inv.number, "sent"], s);
  const refused = cli(["invoice", "rm", inv.number], s);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /Void it instead/);
  assert.equal(cli(["invoice", "rm", inv.number, "--force"], s).code, 0);
});

test("a paid invoice is not edited by accident", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const inv = json(["invoice", "new", "--client", "acme", "--item", "work|1|1000"], s).data.created;
  json(["invoice", "mark", inv.number, "paid"], s);
  const refused = cli(["invoice", "edit", inv.number, "--item", "extra|1|100"], s);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /settled record/);
});

test("edit adds and removes line items and recomputes", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const inv = json(["invoice", "new", "--client", "acme", "--item", "a|1|1000"], s).data.created;
  const bigger = json(["invoice", "edit", inv.number, "--item", "b|1|500"], s).data.invoice;
  assert.equal(bigger.amounts.total, 1500);
  const smaller = json(["invoice", "edit", inv.number, "--rm-item", "1"], s).data.invoice;
  assert.equal(smaller.amounts.total, 500);
  const emptied = cli(["invoice", "edit", inv.number, "--rm-item", "1"], s);
  assert.equal(emptied.code, 2, "an invoice may not be edited down to nothing");
});

test("a client with invoices is archived rather than deleted", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  json(["invoice", "new", "--client", "acme", "--item", "work|1|100"], s);
  const refused = cli(["client", "rm", "acme"], s);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /archive it instead/);
  assert.equal(cli(["client", "archive", "acme"], s).code, 0);
  assert.equal(json(["client", "list"], s).data.clients.length, 0, "archived clients are hidden");
  assert.equal(json(["client", "list", "--archived"], s).data.clients.length, 1);
});

test("render writes each format to a file", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const inv = json(["invoice", "new", "--client", "acme", "--item", "work|1|1000"], s).data.created;
  for (const format of ["md", "html", "txt", "json"]) {
    const out = path.join(s.dir, `inv.${format}`);
    assert.equal(cli(["invoice", "render", inv.number, "--format", format, "--out", out], s).code, 0);
    assert.ok(fs.readFileSync(out, "utf8").includes("1,000.00") || format === "json");
  }
  assert.equal(cli(["invoice", "render", inv.number, "--format", "pdf"], s).code, 2);
});

test("report separates drafts, outstanding and overdue", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  json(["invoice", "new", "--client", "acme", "--item", "draft|1|100"], s);
  const sent = json(["invoice", "new", "--client", "acme", "--item", "sent|1|200"], s).data.created;
  json(["invoice", "mark", sent.number, "sent"], s);
  const paid = json(["invoice", "new", "--client", "acme", "--item", "paid|1|400"], s).data.created;
  json(["invoice", "mark", paid.number, "paid"], s);

  const report = json(["report"], s).data;
  assert.equal(report.totals.draft, 100);
  assert.equal(report.totals.billed, 600);
  assert.equal(report.totals.collected, 400);
  assert.equal(report.totals.outstanding, 200);
  assert.equal(report.byClient[0].client, "acme");
});

test("a currency without minor units is not multiplied by a hundred", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  cli(["init", "--name", "Test Co", "--currency", "JPY"], s);
  // No --currency on the client: the rate has to inherit the business default,
  // or a JPY shop silently prices its clients in dollars.
  cli(["client", "add", "tokyo", "--rate", "15000"], s);
  const inv = json(["invoice", "new", "--client", "tokyo", "--item", "work|1|15000"], s).data.created;
  assert.equal(inv.currency, "JPY");
  assert.equal(inv.amounts.total, 15000);
});

test("an unknown flag fails loudly instead of being ignored", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const res = cli(["invoice", "list", "--bogus"], s);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown flag --bogus/);
});

test("a failed --json run writes the error to stderr and leaves stdout empty", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const res = cli(["invoice", "show", "INV-9999", "--json"], s);
  assert.equal(res.code, 3);
  assert.equal(res.stdout, "");
  assert.equal(JSON.parse(res.stderr).kind, "NotFoundError");
});

test("help and version answer without touching the ledger", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  assert.match(cli(["--version"], s).stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.match(cli([], s).stdout, /billing <command>/);
  assert.match(cli(["help", "invoice"], s).stdout, /--from-timer/);
  assert.equal(cli(["nonesuch"], s).code, 2);
  assert.equal(cli(["invoice", "nonesuch"], s).code, 2);
  assert.equal(cli(["client", "nonesuch"], s).code, 2);
});

test("config reports both files it depends on", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const res = json(["config"], s);
  assert.equal(res.data.dataFile, s.file);
  assert.equal(res.data.timesheetExists, false);
});

test("a client can be pasted out of a signature", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const added = json(["client", "add", '"Globex Inc", https://globex.com, +1-555-0100'], s).data.add;
  assert.equal(added.name, "globex-inc");
  assert.equal(added.displayName, "Globex Inc");
  assert.equal(added.fields.url, "https://globex.com");
  assert.equal(added.fields.phone, "+1-555-0100");
});

test("any dotted flag sets that path, with no field list to be missing from", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  json(["client", "add", "globex"], s);
  const set = json(["client", "set", "globex", "--contact.telephone", "+1-555-0200", "--billing.po", "PO-42"], s).data.set;
  assert.equal(set.fields.contact.telephone, "+1-555-0200");
  assert.equal(set.fields.billing.po, "PO-42");
});

test("setting one field does not drop the others", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  json(["client", "add", "globex", "--contact.name", "Jane"], s);
  const set = json(["client", "set", "globex", "--billing.po", "PO-42"], s).data.set;
  assert.equal(set.fields.contact.name, "Jane", "the earlier field survived");
  assert.equal(set.fields.billing.po, "PO-42");
});

test("a dotted flag cannot reach Object.prototype", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  const res = json(["client", "add", "globex", "--__proto__.polluted", "yes"], s);
  assert.equal(res.code, 0);
  assert.equal(res.data.add.fields.polluted, undefined);
});

test("an undotted unknown flag is still an error", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  // Freeform fields must not turn every typo into a silently accepted field.
  const res = cli(["client", "add", "globex", "--bogus", "x"], s);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown flag --bogus/);
});

test("a payee is recorded, and never guessed", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  json(["client", "add", "globex"], s);
  assert.equal(json(["client", "show", "globex"], s).data.client.payee, null);

  const set = json(["client", "payee", "globex", "solana:9xQeAbc"], s).data.payee;
  assert.deepEqual(set.payee, { chain: "solana", address: "9xQeAbc" });

  // Refusing beats clearing: a typo must not silently unset where money goes.
  const cleared = cli(["client", "payee", "globex"], s);
  assert.equal(cleared.code, 2);
  assert.deepEqual(json(["client", "show", "globex"], s).data.client.payee, { chain: "solana", address: "9xQeAbc" });
});

test("the rendered invoice carries the payee, so a rail can settle it", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  seeded(s);
  json(["client", "add", "globex", "--rate", "150"], s);
  json(["client", "payee", "globex", "solana:9xQeAbc"], s);
  const inv = json(["invoice", "new", "--client", "globex", "--item", "work|1|100"], s).data.created;
  const rendered = JSON.parse(cli(["invoice", "render", inv.number, "--format", "json"], s).stdout);
  assert.equal(rendered.payeeText, "solana:9xQeAbc");
  assert.deepEqual(rendered.payee, { chain: "solana", address: "9xQeAbc" });
});
