// A small argv parser, hand-rolled so the package stays dependency-free.
//
// The one rule worth stating: a flag only consumes the next token if it is
// declared as taking a value. Guessing from the shape of the next token is
// what makes `timer log --json acme` mean two different things on two
// different days, and this tool is meant to be scripted by agents.
export function parseArgs(argv, { booleans = [], values = [], multi = [], aliases = {} } = {}) {
  const isBool = new Set(booleans);
  const takesValue = new Set([...values, ...multi]);
  const isMulti = new Set(multi);
  const flags = Object.create(null);
  const positional = [];
  const rest = [];
  const unknown = [];

  const resolve = (name) => aliases[name] || name;
  const set = (name, value) => {
    if (isMulti.has(name)) (flags[name] ||= []).push(value);
    else flags[name] = value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      let body = token.slice(2);
      let inline = null;
      const eq = body.indexOf("=");
      if (eq !== -1) {
        inline = body.slice(eq + 1);
        body = body.slice(0, eq);
      }
      if (body.startsWith("no-")) {
        const name = resolve(body.slice(3));
        flags[name] = false;
        continue;
      }
      const name = resolve(body);
      if (isBool.has(name)) {
        // `--json=false` is the one way to turn a boolean off inline; agents
        // building command lines from templates rely on it.
        flags[name] = inline == null ? true : !/^(0|false|no)$/i.test(inline);
        continue;
      }
      if (takesValue.has(name)) {
        const value = inline != null ? inline : argv[++i];
        if (value === undefined) throw new Error(`--${body} needs a value`);
        set(name, value);
        continue;
      }
      unknown.push(`--${body}`);
      continue;
    }
    if (token.length > 1 && token.startsWith("-") && !/^-\d/.test(token)) {
      // Short flags, including bundles (-qj). A bundled flag that takes a
      // value must be last, the way tar and grep do it.
      const letters = token.slice(1).split("");
      for (let j = 0; j < letters.length; j += 1) {
        const name = resolve(letters[j]);
        if (isBool.has(name)) { flags[name] = true; continue; }
        if (takesValue.has(name)) {
          const inline = letters.slice(j + 1).join("");
          const value = inline || argv[++i];
          if (value === undefined) throw new Error(`-${letters[j]} needs a value`);
          set(name, value);
          break;
        }
        unknown.push(`-${letters[j]}`);
      }
      continue;
    }
    positional.push(token);
  }
  return { flags, positional, rest, unknown };
}

/** Flags every command answers to, so they are declared once. */
export const GLOBAL_BOOLEANS = ["json", "help", "version", "quiet"];
export const GLOBAL_VALUES = ["data"];
export const GLOBAL_ALIASES = { h: "help", v: "version", q: "quiet", j: "json" };
