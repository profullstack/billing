import assert from "node:assert/strict";
import test from "node:test";

import { applyRate, formatMoney, lineAmount, minorDigits, parseMoney, toMajor } from "../src/money.mjs";

test("parseMoney reads what people type", () => {
  assert.equal(parseMoney("150"), 15000);
  assert.equal(parseMoney("150.50"), 15050);
  assert.equal(parseMoney("$1,250.50"), 125050);
  assert.equal(parseMoney("1 250.50"), 125050);
  assert.equal(parseMoney(150), 15000);
});

test("parseMoney rejects what is not an amount", () => {
  for (const bad of ["", "abc", "1.2.3", "$", null, NaN]) {
    assert.equal(parseMoney(bad), null, `${bad} should not parse`);
  }
});

test("currencies with other minor units are handled without a table", () => {
  assert.equal(minorDigits("USD"), 2);
  assert.equal(minorDigits("JPY"), 0, "yen has no minor unit");
  assert.equal(parseMoney("1500", "JPY"), 1500);
  assert.equal(toMajor(1500, "JPY"), 1500);
});

test("a code Intl does not know is treated as a ticker, not as broken fiat", () => {
  // Anything off the fiat list is a quantity: 8 places so a satoshi survives,
  // and no trailing zeros, because "0.10000000 BTC" hides the number in zeros.
  assert.equal(minorDigits("ZZZ"), 8);
  assert.equal(formatMoney(100000000, "ZZZ"), "1 ZZZ");
  assert.equal(formatMoney(50000000, "SOL"), "0.5 SOL");
  assert.equal(formatMoney(25000000000, "USDC"), "250 USDC");
});

test("rounding happens once per line, so the lines add up to the subtotal", () => {
  // Three lines that each round: 1/3 of an hour at $100 is $33.33, and three
  // of them are $99.99. Rounding only at the end would print $100.00 against
  // lines that visibly sum to $99.99.
  const line = lineAmount(0.33, 10000);
  assert.equal(line, 3300);
  assert.equal(line * 3, 9900);
});

test("tax is a percentage of the rounded subtotal", () => {
  assert.equal(applyRate(300000, 8.25), 24750);
  assert.equal(applyRate(0, 8.25), 0);
});

test("formatMoney groups thousands", () => {
  assert.equal(formatMoney(125050, "USD"), "$1,250.50");
});
