import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readTimesheet, selectBillable, toLineItems } from "../src/timesheet.mjs";
import { scratch, writeTimesheet } from "./helpers.mjs";

const entry = (over) => ({
  id: "e1", project: "acme", task: "work", tags: [],
  start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T10:00:00.000Z",
  billable: true, rate: null, agent: null, ...over,
});

test("a missing timesheet means no hours, not an error", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const sheet = readTimesheet(s.timer);
  assert.equal(sheet.found, false);
  assert.deepEqual(sheet.entries, []);
});

test("a corrupt timesheet is reported, not ignored", (t) => {
  const s = scratch();
  t.after(s.cleanup);
  writeTimesheet(s.timer, []);
  fs.writeFileSync(s.timer, "{oops");
  assert.throws(() => readTimesheet(s.timer), /not valid JSON/);
});

test("a running clock is not billable", () => {
  const picked = selectBillable([entry({ end: null })], { projects: ["acme"] });
  assert.equal(picked.entries.length, 0);
  assert.equal(picked.skipped.running, 1);
});

test("--include-running overrides that, for someone who means it", () => {
  const picked = selectBillable([entry({ end: null })], { projects: ["acme"], includeRunning: true });
  assert.equal(picked.entries.length, 1);
  assert.equal(picked.skipped.running, 1, "it is still reported as unusual");
});

test("unbillable entries and already-billed entries are excluded and counted", () => {
  const picked = selectBillable([
    entry({ id: "a" }),
    entry({ id: "b", billable: false }),
    entry({ id: "c" }),
  ], { projects: ["acme"], billedIds: new Set(["c"]) });
  assert.deepEqual(picked.entries.map((e) => e.id), ["a"]);
  assert.equal(picked.skipped.unbillable, 1);
  assert.equal(picked.skipped.alreadyBilled, 1);
});

test("only the client's projects are billed", () => {
  const picked = selectBillable([
    entry({ id: "a", project: "acme" }),
    entry({ id: "b", project: "other" }),
    entry({ id: "c", project: "ACME" }),
  ], { projects: ["acme"] });
  assert.deepEqual(picked.entries.map((e) => e.id), ["a", "c"]);
});

test("the window compares on the entry start, with an exclusive upper bound", () => {
  const picked = selectBillable([
    entry({ id: "before", start: "2026-07-31T23:00:00.000Z", end: "2026-08-01T01:00:00.000Z" }),
    entry({ id: "inside", start: "2026-08-15T09:00:00.000Z", end: "2026-08-15T10:00:00.000Z" }),
    entry({ id: "boundary", start: "2026-09-01T00:00:00.000Z", end: "2026-09-01T01:00:00.000Z" }),
  ], { projects: ["acme"], since: "2026-08-01T00:00:00.000Z", until: "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(picked.entries.map((e) => e.id), ["inside"]);
});

test("entries on the same task roll into one line item", () => {
  const items = toLineItems([
    entry({ id: "a", task: "auth", start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T12:30:00.000Z" }),
    entry({ id: "b", task: "auth", start: "2026-08-04T09:00:00.000Z", end: "2026-08-04T11:00:00.000Z" }),
    entry({ id: "c", task: "review", start: "2026-08-05T09:00:00.000Z", end: "2026-08-05T10:00:00.000Z" }),
  ], { group: "task", defaultRate: 15000 });
  assert.equal(items.length, 2);
  assert.equal(items[0].description, "auth");
  assert.equal(items[0].quantity, 5.5);
  assert.deepEqual(items[0].timerIds, ["a", "b"]);
});

test("two rates on one task stay two lines rather than becoming a blended rate", () => {
  const items = toLineItems([
    entry({ id: "a", task: "auth", rate: 150 }),
    entry({ id: "b", task: "auth", rate: 200 }),
  ], { group: "task", rateOf: (e) => e.rate * 100 });
  assert.equal(items.length, 2, "a rate a client cannot check must not be invented");
  assert.deepEqual(items.map((i) => i.unitPrice).sort((x, y) => x - y), [15000, 20000]);
});

test("line items come out in chronological order", () => {
  const items = toLineItems([
    entry({ id: "late", task: "zebra", start: "2026-08-20T09:00:00.000Z", end: "2026-08-20T10:00:00.000Z" }),
    entry({ id: "early", task: "apple", start: "2026-08-01T09:00:00.000Z", end: "2026-08-01T10:00:00.000Z" }),
  ], { group: "task", defaultRate: 100 });
  assert.deepEqual(items.map((i) => i.description), ["apple", "zebra"]);
});

test("grouping by day, project and entry each produce their own labels", () => {
  const rows = [
    entry({ id: "a", task: "auth", start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T10:00:00.000Z" }),
    entry({ id: "b", task: "review", start: "2026-08-03T11:00:00.000Z", end: "2026-08-03T12:00:00.000Z" }),
  ];
  assert.equal(toLineItems(rows, { group: "day", defaultRate: 100 }).length, 1);
  assert.equal(toLineItems(rows, { group: "project", defaultRate: 100 }).length, 1);
  assert.equal(toLineItems(rows, { group: "entry", defaultRate: 100 }).length, 2);
  assert.throws(() => toLineItems(rows, { group: "colour" }), /unknown grouping/);
});
