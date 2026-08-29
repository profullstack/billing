import assert from "node:assert/strict";
import test from "node:test";

import { flatten, formatPayee, getPath, parseCommaForm, parsePayee, setPath } from "../src/fields.mjs";

test("setPath builds the objects in between", () => {
  const record = {};
  setPath(record, "contact.telephone", "+1-555-0100");
  setPath(record, "contact.name", "Jane");
  assert.deepEqual(record, { contact: { telephone: "+1-555-0100", name: "Jane" } });
  assert.equal(getPath(record, "contact.name"), "Jane");
  assert.equal(getPath(record, "contact.nope"), undefined);
  assert.equal(getPath(record, "nope.deeper"), undefined);
});

test("setPath refuses a prototype key instead of polluting every object", () => {
  // These paths come straight off a command line: `--__proto__.x` has to be a
  // field called __proto__, or it is a remote write to Object.prototype.
  const record = {};
  setPath(record, "__proto__.polluted", "yes");
  setPath(record, "constructor.prototype.polluted", "yes");
  setPath(record, "a.constructor.polluted", "yes");
  assert.equal({}.polluted, undefined, "Object.prototype was written to");
  assert.equal(Object.prototype.polluted, undefined);
});

test("setPath replaces a non-object on the way through rather than throwing", () => {
  const record = { contact: "just a string" };
  setPath(record, "contact.email", "ap@acme.com");
  assert.deepEqual(record.contact, { email: "ap@acme.com" });
});

test("the comma form reads a pasted signature by shape, not position", () => {
  assert.deepEqual(parseCommaForm('"Acme Inc", https://acme.com, +1-555-0100'), {
    name: "Acme Inc",
    url: "https://acme.com",
    phone: "+1-555-0100",
  });
  // Order does not matter: nobody's signature comes in a fixed one.
  assert.deepEqual(parseCommaForm("Acme, +1-555-0100, ap@acme.com"), {
    name: "Acme",
    phone: "+1-555-0100",
    email: "ap@acme.com",
  });
});

test("a segment nothing recognises is kept, not dropped", () => {
  // Losing a line somebody pasted is worse than filing it imprecisely.
  const parsed = parseCommaForm("Acme, Suite 4, Springfield");
  assert.equal(parsed.name, "Acme");
  assert.equal(parsed.note, "Suite 4, Springfield");
});

test("the comma form on an empty string is an empty record", () => {
  assert.deepEqual(parseCommaForm(""), {});
  assert.deepEqual(parseCommaForm(null), {});
});

test("parsePayee splits a scheme but leaves a bare address alone", () => {
  assert.deepEqual(parsePayee("solana:9xQe"), { chain: "solana", address: "9xQe" });
  assert.deepEqual(parsePayee("9xQe", "solana"), { chain: "solana", address: "9xQe" });
  // A colon further in is part of the address, not a chain.
  assert.equal(parsePayee("abcdefghijklmno:pq").chain, "unknown");
  assert.equal(parsePayee("9xQe").chain, "unknown", "never guess where money goes");
  assert.equal(parsePayee(""), null);
  assert.equal(parsePayee(null), null);
  assert.equal(parsePayee(true), null, "a bare --payee flag is not an address");
});

test("formatPayee round-trips through parsePayee", () => {
  assert.equal(formatPayee(parsePayee("solana:9xQe")), "solana:9xQe");
  assert.equal(formatPayee(null), "");
  assert.equal(formatPayee({ address: "" }), "");
});

test("flatten walks nested records into dotted paths", () => {
  assert.deepEqual(flatten({ a: { b: 1 }, c: 2 }), [["a.b", 1], ["c", 2]]);
  assert.deepEqual(flatten({}), []);
  assert.deepEqual(flatten({ list: ["x"] }), [["list", ["x"]]], "an array is a leaf");
});
