// Money, in minor units.
//
// Everything monetary in the ledger is an integer count of the currency's
// smallest unit — cents, pence, yen. Floats are not an option: 0.1 + 0.2 on an
// invoice total is a number a client can see, and "150.00" typed at the shell
// must round-trip to "150.00" on the rendered document every time.
//
// The number of minor units per major unit comes from Intl rather than a
// hard-coded table, so JPY (0) and KWD (3) are right without this file knowing
// about them.

const FRACTION_CACHE = new Map();

/** How many decimal places this currency has. */
export function minorDigits(currency = "USD") {
  const key = String(currency).toUpperCase();
  if (FRACTION_CACHE.has(key)) return FRACTION_CACHE.get(key);
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en-US", { style: "currency", currency: key })
      .resolvedOptions().maximumFractionDigits;
  } catch {
    // An unknown or made-up currency code still has to work — a client billed
    // in something Intl has never heard of gets two decimals and no crash.
    digits = 2;
  }
  FRACTION_CACHE.set(key, digits);
  return digits;
}

/**
 * Parse an amount into minor units. Returns null when it is not an amount,
 * so callers can produce their own message naming the flag that was wrong.
 *
 * Accepts "150", "150.50", "$150.50", "1,250", "1 250.50".
 */
export function parseMoney(input, currency = "USD") {
  if (input == null) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 10 ** minorDigits(currency));
  }
  const text = String(input).trim().replace(/[\s,]/g, "").replace(/^[^\d.-]+/, "");
  if (!/^-?\d*\.?\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10 ** minorDigits(currency));
}

/** Minor units back to a plain decimal number — for JSON, not for display. */
export function toMajor(minor, currency = "USD") {
  return minor / 10 ** minorDigits(currency);
}

/**
 * Display form: "$1,250.00".
 *
 * Falls back to "1250.00 XYZ" when Intl does not know the code, because an
 * invoice with a blank total is worse than one with an unfamiliar suffix.
 */
export function formatMoney(minor, currency = "USD") {
  const code = String(currency || "USD").toUpperCase();
  const major = toMajor(minor, code);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(major);
  } catch {
    return `${major.toFixed(minorDigits(code))} ${code}`;
  }
}

/**
 * quantity × unit price, in minor units.
 *
 * Rounded once, here, at the line item. Rounding at the line rather than at
 * the total is what makes the printed lines add up to the printed subtotal —
 * a client checking the arithmetic by hand must not find it off by a cent.
 */
export function lineAmount(quantity, unitPriceMinor) {
  return Math.round(Number(quantity) * Number(unitPriceMinor));
}

/** A percentage like 8.25 applied to a minor-unit amount. */
export function applyRate(minor, ratePercent) {
  return Math.round(minor * (Number(ratePercent) / 100));
}
