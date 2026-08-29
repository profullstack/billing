import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { cli, json, scratch } from "./helpers.mjs";

/** A moshcode state directory, in the shape moshcode's business layer writes. */
function moshcode(dir, { clients, rates, invoices, entries }) {
  const home = path.join(dir, "moshcode");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "business.json"), JSON.stringify({
    version: 1, clients: clients || {}, rates: rates || {}, invoices: invoices || {}, teams: {}, payments: {},
  }));
  fs.writeFileSync(path.join(home, "timers.json"), JSON.stringify({
    version: 1, active: null, entries: entries || [],
  }));
  return home;
}

test("with nothing to import it says so instead of failing", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const res = json(["import", "--from", path.join(s.dir, "nowhere")], s);
  assert.equal(res.code, 0);
  assert.equal(res.data.found, false);
});

test("import shows the plan and writes nothing without --apply", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const home = moshcode(s.dir, {
    clients: { c1: { name: "Acme Inc", email: "ap@acme.com" } },
    rates: { c1: { minor: 10000, currency: "USD", per: "hour", unit: "agent", cap: 4 } },
    entries: [{ id: "e1", client: "Acme Inc", task: "auth", start: "2026-08-01T09:00:00.000Z", seconds: 7200, agents: 2 }],
  });
  const dry = json(["import", "--from", home, "--timer-data", s.timer], s);
  assert.deepEqual(dry.data.wouldImport.clients, ["acme-inc"]);
  assert.equal(dry.data.wouldImport.entries, 1);
  assert.equal(json(["client", "list"], s).data.clients.length, 0, "nothing was written");
  assert.equal(fs.existsSync(s.timer), false);
});

test("--apply brings across clients, rates, invoices and entries", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const home = moshcode(s.dir, {
    clients: { c1: { name: "Acme Inc", email: "ap@acme.com" } },
    rates: { c1: { minor: 10000, currency: "USD", per: "hour", unit: "agent", cap: 4 } },
    invoices: {
      i1: {
        number: "INV-0007", client: "c1", status: "sent", currency: "USD",
        issuedAt: "2026-08-01T00:00:00.000Z",
        lines: [{ what: "auth", units: 4, unit: "agent-hours", unitPrice: 100, entries: ["e1"] }],
      },
    },
    entries: [{ id: "e1", client: "Acme Inc", task: "auth", start: "2026-08-01T09:00:00.000Z", seconds: 7200, agents: 2, billed: "i1" }],
  });
  const done = json(["import", "--from", home, "--timer-data", s.timer, "--apply"], s);
  assert.deepEqual(done.data.imported.invoices, ["INV-0007"]);

  const client = json(["client", "show", "acme-inc"], s).data;
  assert.equal(client.resolved.rate.unit, "agent");
  assert.equal(client.resolved.rate.cap, 4);

  const invoices = json(["invoice", "list"], s).data.invoices;
  assert.equal(invoices[0].number, "INV-0007");
  assert.equal(invoices[0].amounts.total, 400);
  assert.equal(invoices[0].status, "sent");

  const sheet = JSON.parse(fs.readFileSync(s.timer, "utf8"));
  assert.equal(sheet.entries.length, 1);
  assert.equal(sheet.entries[0].agents, 2, "the agent count survives the crossing");
});

test("the moshcode files are never modified", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const home = moshcode(s.dir, { clients: { c1: { name: "Acme" } }, entries: [] });
  const before = fs.readFileSync(path.join(home, "business.json"), "utf8");
  cli(["import", "--from", home, "--timer-data", s.timer, "--apply"], s);
  assert.equal(fs.readFileSync(path.join(home, "business.json"), "utf8"), before);
});

test("a client that already exists here is left alone, not merged", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  cli(["init", "--name", "Test Co"], s);
  cli(["client", "add", "acme", "--rate", "999"], s);
  const home = moshcode(s.dir, { clients: { c1: { name: "acme", email: "other@example.com" } }, entries: [] });
  const done = json(["import", "--from", home, "--timer-data", s.timer, "--apply"], s);
  assert.deepEqual(done.data.imported.clients, []);
  assert.match(done.data.notes.join(" "), /already exists/);
  assert.equal(json(["client", "show", "acme"], s).data.resolved.rate.amount, 999, "the local rate wins");
});

test("importing twice does not duplicate the entries", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const home = moshcode(s.dir, {
    clients: { c1: { name: "Acme" } },
    entries: [{ id: "e1", client: "Acme", task: "auth", start: "2026-08-01T09:00:00.000Z", seconds: 3600 }],
  });
  cli(["import", "--from", home, "--timer-data", s.timer, "--apply"], s);
  const again = json(["import", "--from", home, "--timer-data", s.timer, "--apply"], s);
  assert.equal(again.data.imported.entries, 0, "an entry already in the timesheet is skipped");
  assert.equal(JSON.parse(fs.readFileSync(s.timer, "utf8")).entries.length, 1);
});

test("the invoice counter advances past imported numbers", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  cli(["init", "--name", "Test Co"], s);
  const home = moshcode(s.dir, {
    clients: { c1: { name: "Acme" } },
    invoices: { i1: { number: "INV-0007", client: "c1", currency: "USD", lines: [{ what: "x", units: 1, unitPrice: 10 }] } },
    entries: [],
  });
  cli(["import", "--from", home, "--timer-data", s.timer, "--apply"], s);
  const next = json(["invoice", "new", "--client", "acme", "--item", "work|1|100"], s).data.created;
  assert.equal(next.number, "INV-0008", "an imported number is never reissued");
});
