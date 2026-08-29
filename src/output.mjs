// Printing. Two audiences, one code path.
//
// A human gets aligned columns; an agent gets `--json`. The contract that
// makes the agent story work is that *every* command answers --json with a
// single JSON document on stdout and nothing else — no progress lines, no
// warnings, no colour. Anything advisory goes to stderr, which is why `warn`
// exists separately.
const CSI = `${String.fromCharCode(27)}[`;
const NO_COLOR = Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;

const CODES = { dim: "2", bold: "1", red: "31", green: "32", yellow: "33", cyan: "36" };
export function paint(style, text) {
  if (NO_COLOR || !CODES[style]) return String(text);
  return `${CSI}${CODES[style]}m${text}${CSI}0m`;
}

export function emit(text = "") {
  process.stdout.write(`${text}\n`);
}

export function warn(text) {
  process.stderr.write(`${text}\n`);
}

/** The single JSON document a --json run is allowed to print. */
export function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * An aligned table.
 *
 * Column widths come from the visible text, so a value that already carries
 * colour codes would break alignment — which is why callers pass plain values
 * and name the columns they want dimmed instead.
 */
export function table(rows, columns, { dimCols = [] } = {}) {
  if (!rows.length) return "";
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((r) => String(col.get(r) ?? "").length)));
  const pad = (text, i) => (columns[i].align === "right"
    ? String(text).padStart(widths[i])
    : String(text).padEnd(widths[i]));
  const out = [paint("dim", columns.map((c, i) => pad(c.header, i)).join("  ").trimEnd())];
  for (const row of rows) {
    const cells = columns.map((c, i) => {
      const cell = pad(String(c.get(row) ?? ""), i);
      return dimCols.includes(c.header) ? paint("dim", cell) : cell;
    });
    out.push(cells.join("  ").trimEnd());
  }
  return out.join("\n");
}

/** RFC 4180-ish CSV, because a timesheet ends up in a spreadsheet eventually. */
export function csv(rows, columns) {
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => escape(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => escape(c.get(row))).join(","));
  return lines.join("\n");
}
