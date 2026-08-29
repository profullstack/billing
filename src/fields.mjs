// Contact details, written the way they arrive.
//
//   billing client add "Acme Inc", https://acme.com, +1-555-0100
//   billing client add acme --contact.telephone +1-555-0100 --contact.name Jane
//
// The comma form is what a person pastes out of an email signature; the dotted
// form is what a script wants. Neither is a schema. `--contact.telephone` sets
// `contact.telephone` because that is what it says, and any other dotted flag
// does the same, so a record grows the fields a business actually keeps without
// this file having to guess them in advance.
//
// Ported from moshcode, where this shape was designed, so a ledger moving out
// of `~/.moshcode/business.json` arrives with nothing lost. That is the whole
// reason it is here: a typed client model with no room for
// `--billing.po` would have made the migration lossy, and a lossy migration is
// one nobody should run.

/** Fields the comma form recognises by shape, in the order it tries them. */
const LOOKS_LIKE = [
  ["url", (v) => /^https?:\/\//i.test(v) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)],
  ["email", (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)],
  ["phone", (v) => /^[+(]?[\d][\d\s().+-]{5,}$/.test(v)],
];

/** Keys that must never be walked into: these paths come off a command line. */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Set `a.b.c` on an object, creating the objects in between.
 *
 * Own properties only, and never a prototype key: `--__proto__.x` must set a
 * field called `__proto__`, not reach the prototype of every object in the
 * process. Returns the object either way, so a refused path is a no-op rather
 * than a thrown error in the middle of parsing a command line.
 */
export function setPath(obj, dotted, value) {
  const parts = String(dotted).split(".").filter(Boolean);
  if (!parts.length) return obj;
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (FORBIDDEN.has(part)) return obj;
    if (!node[part] || typeof node[part] !== "object" || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  const leaf = parts[parts.length - 1];
  if (FORBIDDEN.has(leaf)) return obj;
  node[leaf] = value;
  return obj;
}

/** Read `a.b.c` back out, or undefined. */
export function getPath(obj, dotted) {
  return String(dotted).split(".").filter(Boolean)
    .reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), obj);
}

/** Every leaf in a nested record, as `a.b.c` -> value. Ordered for display. */
export function flatten(obj, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) out.push(...flatten(value, path));
    else out.push([path, value]);
  }
  return out;
}

/**
 * Read `"Acme Inc", https://acme.com, +1-555-0100` into a record.
 *
 * The first segment is the name; the rest are identified by shape rather than
 * by position, because a signature does not come in a fixed order. A segment
 * nothing recognises is kept under `note` rather than dropped — losing a line
 * somebody pasted is worse than filing it imprecisely.
 */
export function parseCommaForm(text) {
  const segments = String(text ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  if (!segments.length) return {};
  const record = { name: segments[0] };
  const notes = [];
  for (const segment of segments.slice(1)) {
    const match = LOOKS_LIKE.find(([, test]) => test(segment));
    if (match && !record[match[0]]) record[match[0]] = segment;
    else notes.push(segment);
  }
  if (notes.length) record.note = notes.join(", ");
  return record;
}

/**
 * `solana:9xQe…` into `{ chain, address }`.
 *
 * The colon has to be early to be a scheme: an address containing one later is
 * an address, not a chain. Falls back to an explicit `chain` and finally to
 * "unknown" rather than guessing, because the whole point of recording a payee
 * is that nobody has to guess where money goes.
 */
export function parsePayee(value, chain) {
  if (!value || value === true) return null;
  const text = String(value).trim();
  if (!text) return null;
  const split = text.indexOf(":");
  if (split > 0 && split < 12) {
    return { chain: text.slice(0, split).toLowerCase(), address: text.slice(split + 1) };
  }
  return { chain: String(chain || "").toLowerCase() || "unknown", address: text };
}

/** `solana:9xQe…`, for display and for handing to a payment rail. */
export function formatPayee(payee) {
  if (!payee?.address) return "";
  return `${payee.chain || "unknown"}:${payee.address}`;
}
