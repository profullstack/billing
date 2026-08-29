import assert from "node:assert/strict";
import test from "node:test";

import { chargeFor, describeRate, formatRate, normalizeSettlement, parseRate } from "../src/rates.mjs";

test("a rate is the contract sentence, parsed", () => {
  const r = parseRate("$100/hour/agent/upto:4");
  assert.equal(r.minor, 10000);
  assert.equal(r.currency, "USD");
  assert.equal(r.per, "hour");
  assert.equal(r.unit, "agent");
  assert.equal(r.cap, 4);
});

test("everything after the price is order-free", () => {
  // People do not remember an order they were never told.
  assert.equal(formatRate(parseRate("$100/agent/hour")), formatRate(parseRate("$100/hour/agent")));
  assert.equal(formatRate(parseRate("$100/upto:4/agent/hour")), formatRate(parseRate("$100/hour/agent/upto:4")));
});

test("a price is read from either end, with or without a symbol", () => {
  for (const spec of ["$100/hour", "100USD/hour", "100 USD/hour", "USD100/hour"]) {
    assert.equal(parseRate(spec).minor, 10000, spec);
    assert.equal(parseRate(spec).currency, "USD", spec);
  }
  assert.equal(parseRate("0.5 SOL/day").currency, "SOL");
  assert.equal(parseRate("250 USDC/task").currency, "USDC");
});

test("plurals and short forms are accepted", () => {
  assert.equal(parseRate("$100/hours").per, "hour");
  assert.equal(parseRate("$100/hr").per, "hour");
  assert.equal(parseRate("$5000/mo").per, "month");
  assert.equal(parseRate("$100/dev").unit, "person");
});

test("a yearly figure is carried as a monthly one", () => {
  assert.equal(parseRate("$120000/yr").per, "month");
  assert.equal(parseRate("$120000/yr").minor, 1000000, "$10,000 a month");
});

test("a flat fee with no period is a project fee, not an hourly one", () => {
  // Defaulting it to per-hour would silently multiply the invoice by every
  // hour tracked.
  assert.equal(parseRate("$5000/project").per, "project");
  assert.equal(parseRate("$100").per, "hour", "a bare price is still hourly");
});

test("a cap with nothing to cap is refused", () => {
  assert.throws(() => parseRate("$100/hour/upto:4"), /say what it caps/);
});

test("nonsense in a rate names the words that are allowed", () => {
  assert.throws(() => parseRate("$100/fortnight"), /don't know what/);
  assert.throws(() => parseRate("free/hour"), /can't read a price/);
  assert.throws(() => parseRate(""), /looks like/);
  assert.throws(() => parseRate("$100/hour/upto:many"), /whole number/);
});

test("a parsed rate round-trips through its own spelling", () => {
  for (const spec of ["$100/hour/agent/upto:4", "0.5 SOL/day", "250 USDC/task", "$5000/project", "$150/hour/min:2"]) {
    const once = parseRate(spec);
    const twice = parseRate(formatRate(once));
    assert.equal(formatRate(twice), formatRate(once), spec);
  }
});

test("chargeFor multiplies by the agents actually working, up to the cap", () => {
  const rate = parseRate("$100/hour/agent/upto:4");
  assert.equal(chargeFor({ seconds: 3600, agents: 1 }, rate).amount, 10000);
  assert.equal(chargeFor({ seconds: 3600, agents: 3 }, rate).amount, 30000);
  assert.equal(chargeFor({ seconds: 3600, agents: 6 }, rate).amount, 40000, "six agents cost what four do");
  assert.equal(chargeFor({ seconds: 3600, agents: 0 }, rate).amount, 10000, "never less than one");
});

test("a flat rate ignores the agent count", () => {
  const rate = parseRate("$150/hour");
  assert.equal(chargeFor({ seconds: 3600, agents: 4 }, rate).amount, 15000);
});

test("min floors the billed time, not the tracked time", () => {
  const rate = parseRate("$150/hour/min:2");
  const charge = chargeFor({ seconds: 1800, agents: 1 }, rate);
  assert.equal(charge.hours, 0.5);
  assert.equal(charge.billedHours, 2);
  assert.equal(charge.amount, 30000);
});

test("a project fee has no per-entry amount", () => {
  // Inventing a share of a whole-job fee would put a number on the invoice
  // that nobody agreed to.
  assert.equal(chargeFor({ seconds: 3600 }, parseRate("$5000/project")).amount, null);
});

test("settlement preference is separate from the price", () => {
  const rate = parseRate("$100/hour");
  rate.prefer = normalizeSettlement("sol,usdc");
  rate.accept = normalizeSettlement(["fiat"]);
  assert.deepEqual(rate.prefer, ["SOL", "USDC"], "tickers upper-case");
  assert.deepEqual(rate.accept, ["fiat"], "categories stay lower-case");
  assert.equal(rate.currency, "USD", "the contract number did not change because the rail did");
  assert.match(describeRate(rate), /prefers SOL or USDC, fiat accepted/);
});

test("describeRate reads as a sentence", () => {
  assert.equal(
    describeRate(parseRate("$100/hour/agent/upto:4")),
    "$100.00 per hour per agent, billing at most 4 agents",
  );
  assert.equal(describeRate(null), "no rate set");
});
