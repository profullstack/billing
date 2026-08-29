import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readTimesheet, selectBillable, toLineItems, unitLabel } from "../src/timesheet.mjs";
import { parseRate } from "../src/rates.mjs";
import { scratch, writeTimesheet } from "./helpers.mjs";

const entry = (over) => ({
  id: "e1", project: "acme", task: "work", tags: [],
  start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T10:00:00.000Z",
  billable: true, rate: null, agent: null, agents: 1, ...over,
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

const HOURLY = parseRate("$150/hour");

test("entries on the same task roll into one line item", () => {
  const items = toLineItems([
    entry({ id: "a", task: "auth", start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T12:30:00.000Z" }),
    entry({ id: "b", task: "auth", start: "2026-08-04T09:00:00.000Z", end: "2026-08-04T11:00:00.000Z" }),
    entry({ id: "c", task: "review", start: "2026-08-05T09:00:00.000Z", end: "2026-08-05T10:00:00.000Z" }),
  ], { group: "task", rate: HOURLY });
  assert.equal(items.length, 2);
  assert.equal(items[0].description, "auth");
  assert.equal(items[0].quantity, 5.5);
  assert.equal(items[0].unit, "hours");
  assert.deepEqual(items[0].timerIds, ["a", "b"]);
});

test("an agent-priced rate bills agent-hours, so the line can be checked by hand", () => {
  // 3h with 2 agents plus 2h with 1 agent is 8 agent-hours, and the printed
  // quantity times the printed rate has to equal the printed amount.
  const rate = parseRate("$100/hour/agent");
  const items = toLineItems([
    entry({ id: "a", task: "auth", agents: 2, start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T12:00:00.000Z" }),
    entry({ id: "b", task: "auth", agents: 1, start: "2026-08-04T09:00:00.000Z", end: "2026-08-04T11:00:00.000Z" }),
  ], { group: "task", rate });
  assert.equal(items[0].quantity, 8);
  assert.equal(items[0].unit, "agent-hours");
  assert.equal(items[0].hours, 5, "the tracked hours are kept alongside the billed units");
  assert.equal(items[0].quantity * items[0].unitPrice, 80000);
});

test("upto: caps the multiplier, so a sixth agent is free", () => {
  const rate = parseRate("$100/hour/agent/upto:4");
  const items = toLineItems([
    entry({ id: "a", task: "auth", agents: 6, start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T11:00:00.000Z" }),
  ], { group: "task", rate });
  assert.equal(items[0].quantity, 8, "2 hours x 4 capped agents");
});

test("agent counts are never averaged across entries", () => {
  // The failure this guards: summing 5 hours and then charging at the highest
  // agent count seen would bill 20 agent-hours instead of 14.
  const rate = parseRate("$100/hour/agent/upto:4");
  const items = toLineItems([
    entry({ id: "a", task: "auth", agents: 2, start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T12:00:00.000Z" }),
    entry({ id: "b", task: "auth", agents: 6, start: "2026-08-04T09:00:00.000Z", end: "2026-08-04T11:00:00.000Z" }),
  ], { group: "task", rate });
  assert.equal(items[0].quantity, 14, "3h x 2 agents + 2h x 4 capped agents");
});

test("a flat hourly rate ignores the agent count entirely", () => {
  const items = toLineItems([
    entry({ id: "a", task: "auth", agents: 4, start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T11:00:00.000Z" }),
  ], { group: "task", rate: HOURLY });
  assert.equal(items[0].quantity, 2);
  assert.equal(items[0].unit, "hours");
});

test("a daily rate converts tracked hours into days", () => {
  const items = toLineItems([
    entry({ id: "a", task: "auth", start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T17:00:00.000Z" }),
  ], { group: "task", rate: parseRate("$800/day") });
  assert.equal(items[0].quantity, 1, "eight hours is one day");
  assert.equal(items[0].unit, "days");
});

test("min: floors the billed time without touching the tracked time", () => {
  const items = toLineItems([
    entry({ id: "a", task: "callout", start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T09:30:00.000Z" }),
  ], { group: "task", rate: parseRate("$150/hour/min:2") });
  assert.equal(items[0].quantity, 2, "a half hour bills the two-hour minimum");
  assert.equal(items[0].hours, 0.5, "the half hour is still what was tracked");
});

test("a project fee is refused rather than derived from hours", () => {
  assert.throws(
    () => toLineItems([entry({ id: "a" })], { group: "task", rate: parseRate("$5000/project") }),
    /not a function of tracked time/,
  );
});

test("line items come out in chronological order", () => {
  const items = toLineItems([
    entry({ id: "late", task: "zebra", start: "2026-08-20T09:00:00.000Z", end: "2026-08-20T10:00:00.000Z" }),
    entry({ id: "early", task: "apple", start: "2026-08-01T09:00:00.000Z", end: "2026-08-01T10:00:00.000Z" }),
  ], { group: "task", rate: HOURLY });
  assert.deepEqual(items.map((i) => i.description), ["apple", "zebra"]);
});

test("grouping by day, project and entry each produce their own labels", () => {
  const rows = [
    entry({ id: "a", task: "auth", start: "2026-08-03T09:00:00.000Z", end: "2026-08-03T10:00:00.000Z" }),
    entry({ id: "b", task: "review", start: "2026-08-03T11:00:00.000Z", end: "2026-08-03T12:00:00.000Z" }),
  ];
  assert.equal(toLineItems(rows, { group: "day", rate: HOURLY }).length, 1);
  assert.equal(toLineItems(rows, { group: "project", rate: HOURLY }).length, 1);
  assert.equal(toLineItems(rows, { group: "entry", rate: HOURLY }).length, 2);
  assert.throws(() => toLineItems(rows, { group: "colour", rate: HOURLY }), /unknown grouping/);
});

test("unitLabel names what is being billed", () => {
  assert.equal(unitLabel(parseRate("$100/hour")), "hours");
  assert.equal(unitLabel(parseRate("$100/hour/agent")), "agent-hours");
  assert.equal(unitLabel(parseRate("$100/day/seat")), "seat-days");
  assert.equal(unitLabel(parseRate("$100/task")), "tasks");
});
