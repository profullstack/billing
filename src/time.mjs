// Durations and dates, in the spellings people actually type.
//
// Everything stored is an ISO-8601 UTC instant. Everything *typed* is local
// and loose — "1h30m", "90m", "1.5h", "yesterday", "2026-08-01", "09:15".
// This module is the only place that converts between the two, so there is
// one answer to "what does --since mean" rather than one per command.

const UNITS = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };

/**
 * Parse a duration into seconds. Returns null when it is not a duration —
 * callers decide whether that is an error, because "1h" and "an id" arrive
 * through the same argument in a couple of places.
 *
 * Accepts "1h30m", "1h 30m", "90m", "1.5h", "45s", "2d4h", and a bare number
 * (minutes — the unit people mean when they omit one for a work session).
 */
export function parseDuration(input) {
  if (input == null) return null;
  const text = String(input).trim().toLowerCase().replace(/\s+/g, "");
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 60);
  const re = /(\d+(?:\.\d+)?)([wdhms])/g;
  let total = 0;
  let matched = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    total += Number(m[1]) * UNITS[m[2]];
    matched += m[0].length;
  }
  if (matched !== text.length || total <= 0) return null;
  return Math.round(total);
}

/** "2h 15m" — the human spelling, for terminals. */
export function formatDuration(seconds, { compact = false } = {}) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  // Seconds only matter when they are all there is — an 8-hour day reported
  // to the second reads like a stopwatch, not a timesheet.
  if (!h && (sec || !m)) parts.push(`${sec}s`);
  return parts.join(compact ? "" : " ");
}

/** Decimal hours, rounded to 2dp — the number that goes on an invoice. */
export function hours(seconds) {
  return Math.round((seconds / 3600) * 100) / 100;
}

function startOfDay(d) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * Parse a moment. Local time in, UTC ISO string out.
 *
 * Handles the words ("now", "today", "yesterday"), a bare clock time ("09:15"
 * — today at that time), a date ("2026-08-01"), a full ISO instant, and a
 * negative offset ("-90m", "-2h") meaning "that long ago", which is how you
 * fix a clock you forgot to start.
 */
export function parseMoment(input, { now = new Date() } = {}) {
  if (input == null) return null;
  const text = String(input).trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower === "now") return new Date(now).toISOString();
  if (lower === "today") return startOfDay(now).toISOString();
  if (lower === "yesterday") {
    const d = startOfDay(now);
    d.setDate(d.getDate() - 1);
    return d.toISOString();
  }
  if (lower.startsWith("-")) {
    const secs = parseDuration(lower.slice(1));
    if (secs == null) return null;
    return new Date(now.getTime() - secs * 1000).toISOString();
  }
  // A bare clock time means today. This is the common case for `--at 09:15`
  // ("I actually started at quarter past") and would otherwise be a parse
  // error or, worse, 1970.
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (clock) {
    const d = startOfDay(now);
    d.setHours(Number(clock[1]), Number(clock[2]), Number(clock[3] || 0), 0);
    return d.toISOString();
  }
  // A bare date is midnight local, not midnight UTC. `new Date("2026-08-01")`
  // parses as UTC per the spec, which silently shifts a whole day's entries
  // across the boundary for anyone west of Greenwich.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 0, 0, 0, 0);
    return d.toISOString();
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * Turn --since/--until/--today/--week/--month/--period into a concrete window.
 * Both bounds are ISO strings or null (unbounded). `until` is exclusive.
 */
export function resolveWindow(flags = {}, { now = new Date() } = {}) {
  const period = flags.period
    || (flags.today && "today")
    || (flags.week && "week")
    || (flags.month && "month")
    || (flags.year && "year")
    || null;

  let since = flags.since ? parseMoment(flags.since, { now }) : null;
  let until = flags.until ? parseMoment(flags.until, { now }) : null;
  if (flags.since && !since) throw new Error(`--since: cannot read "${flags.since}" as a date`);
  if (flags.until && !until) throw new Error(`--until: cannot read "${flags.until}" as a date`);

  if (period) {
    const from = startOfDay(now);
    switch (period) {
      case "today": break;
      case "yesterday": {
        from.setDate(from.getDate() - 1);
        const to = new Date(from);
        to.setDate(to.getDate() + 1);
        return { since: from.toISOString(), until: to.toISOString() };
      }
      case "week": {
        // Monday-based: a work week starts on Monday everywhere this is used.
        const dow = (from.getDay() + 6) % 7;
        from.setDate(from.getDate() - dow);
        break;
      }
      case "month": from.setDate(1); break;
      case "year": from.setMonth(0, 1); break;
      default: throw new Error(`--period: unknown period "${period}" (today, yesterday, week, month, year)`);
    }
    since = since || from.toISOString();
  }
  return { since, until };
}

/** Local YYYY-MM-DD for an ISO instant — the key `report --group day` uses. */
export function localDay(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Short local timestamp for tables: "Aug 29 14:05". */
export function shortStamp(iso) {
  const d = new Date(iso);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${months[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
