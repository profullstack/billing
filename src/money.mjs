// Money, in exact integers.
//
// Everything monetary is an integer count of the currency's smallest unit.
// Floats are not an option: 0.1 + 0.2 on an invoice total is a number a client
// can see, and "150.00" typed at the shell must round-trip to "150.00" on the
// rendered document every time.
//
// "Smallest unit" means two different things, and both are handled here:
//
//   Fiat gets the number of decimal places Intl knows about, so JPY (0) and
//   KWD (3) are right without this file carrying a table.
//
//   Everything else - USDC, SOL, BTC, a ticker nobody here has heard of - gets
//   8 places, which holds a satoshi. Crypto is a quantity, not a currency Intl
//   can format, and rendering "USDC 250.00" or "0.10000000 BTC" is nobody's
//   idea of a price.

/** Codes that are money in the ISO sense: the ones Intl can format properly. */
const FIAT = new Set(["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "SEK", "NOK", "NZD", "KWD", "INR", "CNY", "BRL", "MXN", "ZAR", "SGD", "HKD", "PLN", "DKK"]);

/** Tickers accepted without a symbol. Not exhaustive - an unknown code is kept as typed. */
export const KNOWN_CRYPTO = new Set(["SOL", "USDC", "USDT", "BTC", "ETH", "MATIC", "BNB", "XRP", "DOGE", "LTC", "AVAX", "ADA", "DAI", "PYUSD", "USDP", "TUSD"]);

/**
 * Stablecoins pegged 1:1 to the dollar.
 *
 * They matter at the payment handoff: a gateway's invoice usually carries a
 * fiat amount and a separate settlement ticker. "250 USDC" is a $250 invoice
 * settled in USDC and can be stated that way honestly; "1.5 SOL" is not $1.50
 * or $150 or any other number we know, and pretending otherwise would put a
 * wrong figure in front of a client. So the peg is written down, not assumed.
 */
const DOLLAR_PEGGED = new Set(["USDC", "USDT", "DAI", "PYUSD", "USDP", "TUSD"]);

/** Decimal places a non-fiat ticker is carried at. Holds a satoshi. */
export const CRYPTO_DIGITS = 8;

const SYMBOLS = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };

export const isFiat = (code) => FIAT.has(String(code || "").toUpperCase());
export const isDollarPegged = (code) => DOLLAR_PEGGED.has(String(code || "").toUpperCase());

const FRACTION_CACHE = new Map();

/** How many decimal places this currency is carried at. */
export function minorDigits(currency = "USD") {
  const key = String(currency || "USD").toUpperCase();
  if (FRACTION_CACHE.has(key)) return FRACTION_CACHE.get(key);
  let digits = CRYPTO_DIGITS;
  if (isFiat(key)) {
    try {
      digits = new Intl.NumberFormat("en-US", { style: "currency", currency: key })
        .resolvedOptions().maximumFractionDigits;
    } catch {
      digits = 2;
    }
  }
  FRACTION_CACHE.set(key, digits);
  return digits;
}

/**
 * Parse an amount into minor units. Returns null when it is not an amount, so
 * callers can produce their own message naming the flag that was wrong.
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

/**
 * Read a price with its currency attached, from any of the spellings that turn
 * up in the same conversation: "$100", "100USD", "100 USD", "USDC250", "0.5 SOL".
 */
export function parsePrice(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const symbol = SYMBOLS[raw[0]];
  const body = symbol ? raw.slice(1) : raw;
  const m = body.match(/^([a-z]{2,5})?\s*([0-9][0-9_,]*(?:\.[0-9]+)?)\s*([a-z]{2,5})?$/i);
  if (!m) return null;
  const value = Number(m[2].replace(/[_,]/g, ""));
  if (!Number.isFinite(value) || value < 0) return null;
  const code = (m[1] || m[3] || "").toUpperCase();
  if (code && !isFiat(code) && !KNOWN_CRYPTO.has(code) && !/^[A-Z]{3,5}$/.test(code)) return null;
  const currency = code || symbol || "USD";
  return { minor: Math.round(value * 10 ** minorDigits(currency)), currency };
}

/** Minor units back to a plain decimal number - for JSON, not for display. */
export function toMajor(minor, currency = "USD") {
  return Number((minor / 10 ** minorDigits(currency)).toFixed(minorDigits(currency)));
}

export function fromMajor(major, currency = "USD") {
  return Math.round(Number(major) * 10 ** minorDigits(currency));
}

/**
 * Display form. Fiat goes through Intl (symbol, grouping, its own decimals);
 * anything else is "<amount> <TICKER>" with trailing zeros trimmed, because a
 * crypto amount is read as a quantity: 0.5 SOL is 0.5 SOL, not 0.50000000 SOL.
 */
export function formatMoney(minor, currency = "USD") {
  const code = String(currency || "USD").toUpperCase();
  const major = minor / 10 ** minorDigits(code);
  if (isFiat(code)) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(major);
    } catch { /* fall through to the ticker form */ }
  }
  const fixed = major.toFixed(minorDigits(code)).replace(/\.?0+$/, "");
  return `${fixed || "0"} ${code}`;
}

/**
 * quantity x unit price, in minor units.
 *
 * Rounded once, here, at the line item. Rounding at the line rather than at the
 * total is what makes the printed lines add up to the printed subtotal - a
 * client checking the arithmetic by hand must not find it off by a cent.
 */
export function lineAmount(quantity, unitPriceMinor) {
  return Math.round(Number(quantity) * Number(unitPriceMinor));
}

/** A percentage like 8.25 applied to a minor-unit amount. */
export function applyRate(minor, ratePercent) {
  return Math.round(minor * (Number(ratePercent) / 100));
}
