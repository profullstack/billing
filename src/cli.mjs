// The command surface.
//
// Two-level: `billing client add`, `billing invoice new`. The nesting is there
// because both nouns have the same verbs, and a flat vocabulary would need
// `add-client` / `add-invoice` pairs that read worse from a slash command.
import fs from "node:fs";

import { GLOBAL_ALIASES, GLOBAL_BOOLEANS, GLOBAL_VALUES, parseArgs } from "./args.mjs";
import { billingHome, dataFile, timerDataFile } from "./paths.mjs";
import { read, update } from "./store.mjs";
import { csv, emit, emitJson, paint, table, warn } from "./output.mjs";
import { formatMoney, parseMoney, toMajor } from "./money.mjs";
import { findClient, makeClient, normalizeHandle, normalizeProjects, projectsFor, resolve } from "./clients.mjs";
import {
  STATUSES,
  billedEntryIds,
  canTransition,
  dueFrom,
  effectiveStatus,
  findInvoice,
  makeInvoice,
  makeItem,
  nextNumber,
  recompute,
  summarize,
} from "./invoices.mjs";
import { GROUP_KEYS, hoursOf, readTimesheet, selectBillable, toLineItems } from "./timesheet.mjs";
import { FORMATS, longDate, render } from "./render.mjs";
import { parseMoment, resolveWindow } from "./time.mjs";

export const VERSION = "0.1.0";

export class UsageError extends Error {
  constructor(message) { super(message); this.name = "UsageError"; this.exitCode = 2; }
}
export class NotFoundError extends Error {
  constructor(message) { super(message); this.name = "NotFoundError"; this.exitCode = 3; }
}

const WINDOW_BOOLEANS = ["today", "yesterday", "week", "month", "year"];
const WINDOW_VALUES = ["since", "until", "period"];

/** `"Design retainer|1|2500"` -> a line item. */
function parseItemSpec(spec, currency) {
  const parts = String(spec).split("|").map((p) => p.trim());
  if (parts.length === 1) throw new UsageError(`--item "${spec}": expected "description|quantity|price" or "description|price"`);
  const description = parts[0];
  let quantity = 1;
  let priceText;
  if (parts.length === 2) [, priceText] = parts;
  else {
    quantity = Number(parts[1]);
    priceText = parts[2];
    if (!Number.isFinite(quantity)) throw new UsageError(`--item "${spec}": "${parts[1]}" is not a quantity`);
  }
  const unitPrice = parseMoney(priceText, currency);
  if (unitPrice == null) throw new UsageError(`--item "${spec}": "${priceText}" is not an amount`);
  // No unit. A hand-written item is a retainer, a fee, a licence: only the
  // items built from the timesheet are measured in hours, and stamping
  // "hours" on everything renders a flat fee as "1 hours".
  return { description, quantity, unit: "", unitPrice };
}

function serializeInvoice(invoice, now = new Date()) {
  return {
    ...invoice,
    status: invoice.status,
    effectiveStatus: effectiveStatus(invoice, now),
    amounts: {
      subtotal: toMajor(invoice.subtotal, invoice.currency),
      tax: toMajor(invoice.tax, invoice.currency),
      total: toMajor(invoice.total, invoice.currency),
      amountPaid: toMajor(invoice.amountPaid || 0, invoice.currency),
      balance: toMajor(invoice.total - (invoice.amountPaid || 0), invoice.currency),
    },
  };
}

function requireClient(store, name) {
  if (!name) throw new UsageError("which client? pass --client <name>");
  const client = findClient(store, name);
  if (!client) {
    const known = store.clients.map((c) => c.name).join(", ");
    throw new NotFoundError(`no client "${name}"${known ? ` (known: ${known})` : " — add one with: billing client add <name>"}`);
  }
  return client;
}

/**
 * Gather the timer entries an invoice would cover, plus what was skipped.
 * Shared by `invoice new` and `hours`, so the preview and the real thing can
 * never disagree about which hours are billable.
 */
function gatherTimerItems(store, client, flags, { exceptInvoiceId = null } = {}) {
  const timerFile = flags["timer-data"] || timerDataFile();
  const sheet = readTimesheet(timerFile);
  const { since, until } = resolveWindow(flags);
  const terms = resolve(client, store.business);
  const currency = (flags.currency || terms.currency).toUpperCase();
  const projects = flags.project ? normalizeProjects(flags.project) : projectsFor(client);

  const rateOverride = flags.rate != null ? parseMoney(flags.rate, currency) : null;
  if (flags.rate != null && rateOverride == null) throw new UsageError(`--rate: "${flags.rate}" is not an amount`);
  const fallbackRate = rateOverride ?? terms.rate;
  if (fallbackRate == null) {
    throw new UsageError(
      `no hourly rate for "${client.name}" — set one with: billing client set ${client.name} --rate 150`,
    );
  }

  const picked = selectBillable(sheet.entries, {
    projects,
    since,
    until,
    billedIds: billedEntryIds(store, { exceptInvoiceId }),
    includeRunning: Boolean(flags["include-running"]),
  });

  const group = flags.group || "task";
  if (!GROUP_KEYS.includes(group)) throw new UsageError(`--group: unknown grouping "${group}" (${GROUP_KEYS.join(", ")})`);

  const items = toLineItems(picked.entries, {
    group,
    // An entry's own rate wins over the client's: `timer start acme --rate 200`
    // is how you record work that was agreed at a different price, and losing
    // that here would quietly under- or over-bill it.
    rateOf: (e) => (e.rate != null ? parseMoney(e.rate, currency) : fallbackRate),
  });
  return { items, picked, sheet, projects, currency, terms, timerFile };
}

// ---------------------------------------------------------------------------

const CLIENT_VERBS = ["add", "list", "show", "set", "rm", "archive", "unarchive"];
const INVOICE_VERBS = ["new", "list", "show", "render", "mark", "edit", "rm"];

const COMMANDS = [
  {
    name: "init",
    aliases: ["business"],
    args: "[--name … --email … --rate …]",
    summary: "set up (or change) the business on the invoices",
    booleans: [],
    values: ["name", "email", "address", "currency", "rate", "tax", "tax-label", "terms", "prefix", "payment", "footer"],
    detail: [
      "Every field is optional and only what you pass is changed, so this doubles",
      "as `business set`. With no flags it prints the current profile.",
      "",
      "  billing init --name 'Profullstack, LLC' --email billing@example.com \\",
      "    --rate 150 --terms 14 --payment 'ACH: ...'",
    ],
    run({ flags, file }) {
      const map = {
        name: "name", email: "email", address: "address",
        prefix: "invoicePrefix", payment: "paymentInstructions", footer: "footer",
        "tax-label": "taxLabel",
      };
      const business = update((store) => {
        for (const [flag, key] of Object.entries(map)) {
          if (flags[flag] != null) store.business[key] = String(flags[flag]);
        }
        if (flags.currency != null) store.business.currency = String(flags.currency).toUpperCase();
        if (flags.rate != null) {
          const rate = parseMoney(flags.rate, store.business.currency);
          if (rate == null) throw new UsageError(`--rate: "${flags.rate}" is not an amount`);
          store.business.rate = toMajor(rate, store.business.currency);
        }
        if (flags.tax != null) {
          const tax = Number(flags.tax);
          if (!Number.isFinite(tax)) throw new UsageError(`--tax: "${flags.tax}" is not a percentage`);
          store.business.taxRate = tax;
        }
        if (flags.terms != null) {
          const terms = Number(flags.terms);
          if (!Number.isFinite(terms)) throw new UsageError(`--terms: "${flags.terms}" is not a number of days`);
          store.business.terms = terms;
        }
        return store.business;
      }, { file });

      if (flags.json) return emitJson({ business });
      emit(paint("bold", business.name || "(no business name yet)"));
      if (business.email) emit(business.email);
      if (business.address) emit(paint("dim", business.address));
      emit("");
      emit(`currency  ${business.currency}`);
      emit(`rate      ${business.rate == null ? paint("dim", "not set") : formatMoney(parseMoney(business.rate, business.currency), business.currency) + "/hour"}`);
      emit(`tax       ${business.taxRate}%  (${business.taxLabel})`);
      emit(`terms     net ${business.terms} days`);
      emit(`numbering ${business.invoicePrefix || "(none)"}-0001`);
      if (!business.name) {
        emit("");
        warn("no business name yet — billing init --name 'Your Company'");
      }
    },
  },
  {
    name: "client",
    aliases: ["clients"],
    args: `<${CLIENT_VERBS.join("|")}> [name]`,
    summary: "who you bill, and on what terms",
    booleans: ["archived"],
    values: ["display", "email", "address", "rate", "currency", "tax", "terms", "notes", "name"],
    multi: ["project"],
    detail: [
      "  billing client add acme --display 'Acme Corp' --rate 150 --email ap@acme.com",
      "  billing client set acme --rate 175 --project acme-api",
      "  billing client list",
      "",
      "A client bills the timer projects named by --project. With none given it",
      "bills the project matching its own handle, so `timer start acme` and",
      "`billing client add acme` line up with nothing to configure.",
    ],
    run({ positional, flags, file }) {
      const verb = (positional[0] || "list").toLowerCase();
      if (!CLIENT_VERBS.includes(verb)) throw new UsageError(`billing client: unknown verb "${verb}" (${CLIENT_VERBS.join(", ")})`);
      const name = flags.name || positional[1];

      if (verb === "list") {
        const store = read(file);
        const rows = store.clients
          .filter((c) => (flags.archived ? true : !c.archived))
          .map((c) => {
            const terms = resolve(c, store.business);
            return {
              name: c.name,
              displayName: c.displayName,
              email: c.email,
              rate: terms.rate == null ? null : toMajor(terms.rate, terms.currency),
              rateText: terms.rate == null ? "-" : formatMoney(terms.rate, terms.currency),
              currency: terms.currency,
              terms: terms.terms,
              projects: projectsFor(c),
              archived: c.archived,
            };
          });
        if (flags.json) return emitJson({ clients: rows });
        if (!rows.length) { warn("no clients yet — billing client add <name>"); return; }
        emit(table(rows, [
          { header: "CLIENT", get: (r) => r.name },
          { header: "NAME", get: (r) => r.displayName },
          { header: "RATE", get: (r) => r.rateText, align: "right" },
          { header: "TERMS", get: (r) => `net ${r.terms}` },
          { header: "PROJECTS", get: (r) => r.projects.join(",") },
          { header: "", get: (r) => (r.archived ? "archived" : "") },
        ]));
        return;
      }

      if (verb === "show") {
        const store = read(file);
        const client = requireClient(store, name);
        const terms = resolve(client, store.business);
        const invoices = store.invoices.filter((i) => i.clientId === client.id);
        const money = summarize(invoices);
        if (flags.json) {
          return emitJson({ client, resolved: { ...terms, rate: terms.rate == null ? null : toMajor(terms.rate, terms.currency) }, projects: projectsFor(client), summary: money });
        }
        emit(paint("bold", client.displayName));
        emit(paint("dim", `handle ${client.name}`));
        if (client.email) emit(client.email);
        if (client.address) emit(paint("dim", client.address));
        emit("");
        emit(`rate      ${terms.rate == null ? paint("dim", "not set") : `${formatMoney(terms.rate, terms.currency)}/hour`}`);
        emit(`terms     net ${terms.terms}`);
        emit(`tax       ${terms.taxRate}%`);
        emit(`projects  ${projectsFor(client).join(", ")}`);
        emit("");
        emit(`invoices  ${invoices.length}   outstanding ${formatMoney(money.outstanding, terms.currency)}`
          + (money.overdue ? paint("red", `   overdue ${formatMoney(money.overdue, terms.currency)}`) : ""));
        return;
      }

      // The mutating verbs.
      const result = update((store) => {
        if (verb === "add") {
          if (!name) throw new UsageError("billing client add <name>");
          if (findClient(store, name)) throw new UsageError(`client "${normalizeHandle(name)}" already exists`);
          const client = makeClient({
            name,
            displayName: flags.display || "",
            email: flags.email,
            address: flags.address,
            rate: flags.rate,
            currency: flags.currency,
            taxRate: flags.tax,
            terms: flags.terms,
            projects: flags.project || [],
            notes: flags.notes,
          });
          store.clients.push(client);
          return { verb, client };
        }
        const client = requireClient(store, name);
        if (verb === "set") {
          if (flags.display != null) client.displayName = String(flags.display);
          if (flags.email != null) client.email = String(flags.email);
          if (flags.address != null) client.address = String(flags.address);
          if (flags.notes != null) client.notes = String(flags.notes);
          if (flags.currency != null) client.currency = String(flags.currency).toUpperCase();
          if (flags.project) client.projects = normalizeProjects(flags.project);
          for (const [flag, key] of [["rate", "rate"], ["tax", "taxRate"], ["terms", "terms"]]) {
            if (flags[flag] == null) continue;
            const value = Number(String(flags[flag]).replace(/[^\d.-]/g, ""));
            if (!Number.isFinite(value)) throw new UsageError(`--${flag}: "${flags[flag]}" is not a number`);
            client[key] = value;
          }
          return { verb, client };
        }
        if (verb === "archive" || verb === "unarchive") {
          client.archived = verb === "archive";
          return { verb, client };
        }
        // rm
        const owned = store.invoices.filter((i) => i.clientId === client.id);
        if (owned.length) {
          throw new UsageError(
            `"${client.name}" has ${owned.length} invoice(s) — archive it instead: billing client archive ${client.name}`,
          );
        }
        store.clients.splice(store.clients.indexOf(client), 1);
        return { verb, client };
      }, { file });

      if (flags.json) return emitJson({ [result.verb]: result.client });
      const verbWord = { add: "added", set: "updated", rm: "removed", archive: "archived", unarchive: "restored" }[result.verb];
      emit(`${paint("green", verbWord)} ${result.client.name}  ${paint("dim", result.client.displayName)}`);
    },
  },
  {
    name: "hours",
    aliases: ["unbilled"],
    args: "--client <name>",
    summary: "tracked hours not yet on an invoice",
    booleans: [...WINDOW_BOOLEANS, "include-running"],
    values: [...WINDOW_VALUES, "client", "group", "rate", "currency", "timer-data"],
    multi: ["project"],
    detail: [
      "The preview of what `invoice new --from-timer` would bill, with nothing",
      "written. Same filters, same grouping, same arithmetic.",
      "",
      "  billing hours --client acme --month",
    ],
    run({ positional, flags, file }) {
      const store = read(file);
      const client = requireClient(store, flags.client || positional[0]);
      const { items, picked, sheet, projects, currency, timerFile } = gatherTimerItems(store, client, flags);
      const subtotal = items.reduce((n, i) => n + Math.round(i.quantity * i.unitPrice), 0);
      const totalHours = Math.round(items.reduce((n, i) => n + i.quantity, 0) * 100) / 100;

      if (flags.json) {
        return emitJson({
          client: client.name,
          projects,
          currency,
          timerFile,
          timesheetFound: sheet.found,
          items: items.map((i) => ({ ...i, unitPriceMajor: toMajor(i.unitPrice, currency), amount: toMajor(Math.round(i.quantity * i.unitPrice), currency) })),
          hours: totalHours,
          subtotal: toMajor(subtotal, currency),
          skipped: picked.skipped,
        });
      }
      if (!sheet.found) { warn(`no timesheet at ${timerFile} — track time with: timer start ${projects[0]}`); return; }
      if (!items.length) { warn(`nothing unbilled for ${client.name} in that window`); return; }
      emit(table(items, [
        { header: "DESCRIPTION", get: (i) => i.description },
        { header: "HOURS", get: (i) => i.quantity.toFixed(2), align: "right" },
        { header: "RATE", get: (i) => formatMoney(i.unitPrice, currency), align: "right" },
        { header: "AMOUNT", get: (i) => formatMoney(Math.round(i.quantity * i.unitPrice), currency), align: "right" },
      ]));
      emit("");
      emit(`${totalHours.toFixed(2)}h unbilled  ${paint("bold", formatMoney(subtotal, currency))}`);
      const { running, alreadyBilled, unbillable } = picked.skipped;
      const notes = [];
      if (running) notes.push(`${running} clock still running (not billable until stopped)`);
      if (alreadyBilled) notes.push(`${alreadyBilled} already on an invoice`);
      if (unbillable) notes.push(`${unbillable} marked unbillable`);
      if (notes.length) emit(paint("dim", `skipped: ${notes.join(", ")}`));
    },
  },
  {
    name: "invoice",
    aliases: ["invoices", "inv"],
    args: `<${INVOICE_VERBS.join("|")}> [number]`,
    summary: "create, list, render and settle invoices",
    booleans: [...WINDOW_BOOLEANS, "from-timer", "include-running", "dry-run", "force", "overdue", "all"],
    values: [
      ...WINDOW_VALUES, "client", "group", "rate", "currency", "tax", "terms", "due", "issued",
      "note", "po", "number", "status", "format", "out", "at", "amount", "rm-item", "timer-data", "limit",
    ],
    multi: ["item", "project"],
    detail: [
      "  billing invoice new --client acme --from-timer --month",
      "  billing invoice new --client acme --item 'Retainer|1|2500'",
      "  billing invoice list --status sent --overdue",
      "  billing invoice render INV-0001 --format html --out acme-aug.html",
      "  billing invoice mark INV-0001 paid",
      "",
      `--group takes ${GROUP_KEYS.join(", ")} (default task).`,
      `--format takes ${FORMATS.join(", ")} (default md).`,
      "",
      "--dry-run on `new` prints the invoice that would be created and writes",
      "nothing, which is the safe way for an agent to propose one.",
    ],
    run(ctx) {
      const verb = (ctx.positional[0] || "list").toLowerCase();
      if (!INVOICE_VERBS.includes(verb)) throw new UsageError(`billing invoice: unknown verb "${verb}" (${INVOICE_VERBS.join(", ")})`);
      return INVOICE_HANDLERS[verb]({ ...ctx, positional: ctx.positional.slice(1) });
    },
  },
  {
    name: "report",
    aliases: ["summary"],
    summary: "billed, collected, outstanding and overdue",
    booleans: WINDOW_BOOLEANS,
    values: [...WINDOW_VALUES, "client"],
    detail: [
      "Windows apply to the issue date. Draft invoices are counted separately —",
      "they are not money anybody owes you yet.",
    ],
    run({ flags, file }) {
      const store = read(file);
      const { since, until } = resolveWindow(flags);
      const now = new Date();
      let invoices = store.invoices;
      if (flags.client) {
        const client = requireClient(store, flags.client);
        invoices = invoices.filter((i) => i.clientId === client.id);
      }
      if (since) invoices = invoices.filter((i) => i.issuedAt >= since);
      if (until) invoices = invoices.filter((i) => i.issuedAt < until);

      const currency = store.business.currency || "USD";
      const overall = summarize(invoices, now);
      const byClient = store.clients.map((c) => {
        const mine = invoices.filter((i) => i.clientId === c.id);
        return { client: c.name, ...summarize(mine, now) };
      }).filter((r) => r.invoices > 0).sort((a, b) => b.outstanding - a.outstanding || b.billed - a.billed);

      if (flags.json) {
        const asMajor = (row) => ({
          ...row,
          billed: toMajor(row.billed, currency),
          collected: toMajor(row.collected, currency),
          outstanding: toMajor(row.outstanding, currency),
          overdue: toMajor(row.overdue, currency),
          draft: toMajor(row.draft, currency),
        });
        return emitJson({ currency, totals: asMajor(overall), byClient: byClient.map(asMajor) });
      }
      emit(`billed       ${formatMoney(overall.billed, currency)}`);
      emit(`collected    ${formatMoney(overall.collected, currency)}`);
      emit(`outstanding  ${paint("bold", formatMoney(overall.outstanding, currency))}`);
      if (overall.overdue) emit(`overdue      ${paint("red", formatMoney(overall.overdue, currency))}`);
      if (overall.draft) emit(paint("dim", `draft        ${formatMoney(overall.draft, currency)} (not issued)`));
      if (byClient.length) {
        emit("");
        emit(table(byClient, [
          { header: "CLIENT", get: (r) => r.client },
          { header: "INVOICES", get: (r) => r.invoices, align: "right" },
          { header: "BILLED", get: (r) => formatMoney(r.billed, currency), align: "right" },
          { header: "OUTSTANDING", get: (r) => formatMoney(r.outstanding, currency), align: "right" },
          { header: "OVERDUE", get: (r) => (r.overdue ? formatMoney(r.overdue, currency) : "-"), align: "right" },
        ]));
      }
    },
  },
  {
    name: "config",
    aliases: ["where", "paths"],
    summary: "where the ledger and the timesheet live",
    booleans: [],
    values: [],
    run({ flags, file }) {
      const exists = fs.existsSync(file);
      const store = exists ? read(file) : null;
      const timer = timerDataFile();
      if (flags.json) {
        return emitJson({
          version: VERSION,
          dataFile: file,
          home: billingHome(),
          exists,
          timerDataFile: timer,
          timesheetExists: fs.existsSync(timer),
          clients: store ? store.clients.length : 0,
          invoices: store ? store.invoices.length : 0,
          business: store ? store.business : null,
        });
      }
      emit(`billing    ${VERSION}`);
      emit(`ledger     ${file}${exists ? "" : paint("dim", "  (not created yet)")}`);
      emit(`home       ${billingHome()}`);
      emit(`timesheet  ${timer}${fs.existsSync(timer) ? "" : paint("dim", "  (not found)")}`);
      emit(`clients    ${store ? store.clients.length : 0}`);
      emit(`invoices   ${store ? store.invoices.length : 0}`);
      emit("");
      emit(paint("dim", "override with BILLING_DATA / BILLING_HOME / PROFULLSTACK_HOME, TIMER_DATA for the timesheet"));
    },
  },
];

// ---------------------------------------------------------------------------
// The invoice verbs. Split out because `invoice` carries seven of them and the
// COMMANDS table above is meant to stay readable as a table.

const INVOICE_HANDLERS = {
  new({ flags, file }) {
    const now = new Date();
    const issuedAt = flags.issued ? parseMoment(flags.issued, { now }) : now.toISOString();
    if (flags.issued && !issuedAt) throw new UsageError(`--issued: cannot read "${flags.issued}" as a date`);

    const built = update((store) => {
      const client = requireClient(store, flags.client);
      const terms = resolve(client, store.business);
      const currency = (flags.currency || terms.currency).toUpperCase();

      const items = [];
      if (flags["from-timer"]) {
        const gathered = gatherTimerItems(store, client, flags);
        if (!gathered.sheet.found) {
          throw new NotFoundError(`no timesheet at ${gathered.timerFile} — nothing to bill`);
        }
        if (!gathered.items.length) {
          const s = gathered.picked.skipped;
          throw new NotFoundError(
            `no unbilled hours for ${client.name} in that window`
            + (s.running ? ` (${s.running} clock still running — stop it first)` : "")
            + (s.alreadyBilled ? ` (${s.alreadyBilled} already invoiced)` : ""),
          );
        }
        items.push(...gathered.items);
      }
      for (const spec of flags.item || []) items.push(parseItemSpec(spec, currency));
      if (!items.length) {
        throw new UsageError("an invoice needs line items — pass --from-timer or --item 'Description|1|2500'");
      }

      let taxRate = terms.taxRate;
      if (flags.tax != null) {
        taxRate = Number(flags.tax);
        if (!Number.isFinite(taxRate)) throw new UsageError(`--tax: "${flags.tax}" is not a percentage`);
      }
      let dueAt;
      if (flags.due) {
        dueAt = parseMoment(flags.due, { now });
        if (!dueAt) throw new UsageError(`--due: cannot read "${flags.due}" as a date`);
      } else {
        dueAt = dueFrom(issuedAt, flags.terms != null ? flags.terms : terms.terms);
      }

      const numbering = flags.number ? { number: flags.number, counter: store.counter } : nextNumber(store);
      if (flags.number && store.invoices.some((i) => i.number === flags.number)) {
        throw new UsageError(`invoice ${flags.number} already exists`);
      }
      const invoice = makeInvoice({
        client,
        number: numbering.number,
        currency,
        taxRate,
        taxLabel: store.business.taxLabel,
        items,
        issuedAt,
        dueAt,
        notes: flags.note || "",
        poNumber: flags.po || "",
      });

      // --dry-run computes everything and throws the result away. Doing the
      // full build first is the point: a dry run that skipped validation
      // would happily "preview" an invoice the real command would refuse.
      if (flags["dry-run"]) return { invoice, client, business: store.business, dryRun: true };

      store.counter = numbering.counter;
      store.invoices.push(invoice);
      return { invoice, client, business: store.business, dryRun: false };
    }, { file });

    if (flags.json) {
      return emitJson({ [built.dryRun ? "wouldCreate" : "created"]: serializeInvoice(built.invoice, now) });
    }
    emit(render(built.invoice, { format: "txt", business: built.business, client: built.client, now }));
    if (built.dryRun) warn("dry run — nothing was written");
    else if (!flags.quiet) {
      emit(paint("green", `created ${built.invoice.number}`)
        + paint("dim", `  billing invoice render ${built.invoice.number} --format html --out ${built.invoice.number}.html`));
    }
  },

  list({ flags, file }) {
    const store = read(file);
    const now = new Date();
    let invoices = [...store.invoices];
    if (flags.client) {
      const client = requireClient(store, flags.client);
      invoices = invoices.filter((i) => i.clientId === client.id);
    }
    if (flags.status) {
      const want = String(flags.status).toLowerCase();
      if (![...STATUSES, "overdue"].includes(want)) {
        throw new UsageError(`--status: unknown status "${flags.status}" (${[...STATUSES, "overdue"].join(", ")})`);
      }
      invoices = invoices.filter((i) => effectiveStatus(i, now) === want);
    }
    if (flags.overdue) invoices = invoices.filter((i) => effectiveStatus(i, now) === "overdue");
    const { since, until } = resolveWindow(flags);
    if (since) invoices = invoices.filter((i) => i.issuedAt >= since);
    if (until) invoices = invoices.filter((i) => i.issuedAt < until);
    invoices.sort((a, b) => (a.issuedAt < b.issuedAt ? -1 : 1));
    if (flags.limit) {
      const n = Number(flags.limit);
      if (!Number.isFinite(n) || n <= 0) throw new UsageError("--limit must be a positive number");
      invoices = invoices.slice(-n);
    }

    if (flags.json) {
      return emitJson({
        invoices: invoices.map((i) => serializeInvoice(i, now)),
        totals: summarize(invoices, now),
      });
    }
    if (!invoices.length) { warn("no invoices match"); return; }
    emit(table(invoices, [
      { header: "NUMBER", get: (i) => i.number },
      { header: "CLIENT", get: (i) => i.clientName },
      { header: "ISSUED", get: (i) => i.issuedAt.slice(0, 10) },
      { header: "DUE", get: (i) => (i.dueAt ? i.dueAt.slice(0, 10) : "-") },
      { header: "TOTAL", get: (i) => formatMoney(i.total, i.currency), align: "right" },
      { header: "BALANCE", get: (i) => formatMoney(i.total - (i.amountPaid || 0), i.currency), align: "right" },
      { header: "STATUS", get: (i) => effectiveStatus(i, now) },
    ]));
    const money = summarize(invoices, now);
    const currency = store.business.currency || "USD";
    emit("");
    emit(`${invoices.length} invoice(s)  outstanding ${paint("bold", formatMoney(money.outstanding, currency))}`
      + (money.overdue ? paint("red", `  overdue ${formatMoney(money.overdue, currency)}`) : ""));
  },

  show({ positional, flags, file }) {
    const store = read(file);
    const now = new Date();
    const invoice = findInvoice(store, positional[0] || flags.number);
    if (!invoice) throw new NotFoundError(`no invoice "${positional[0] || flags.number || ""}"`);
    const client = store.clients.find((c) => c.id === invoice.clientId) || null;
    if (flags.json) return emitJson({ invoice: serializeInvoice(invoice, now) });
    emit(render(invoice, { format: "txt", business: store.business, client, now }));
    emit(paint("dim", `status ${effectiveStatus(invoice, now)}`
      + (invoice.sentAt ? ` · sent ${longDate(invoice.sentAt)}` : "")
      + (invoice.paidAt ? ` · paid ${longDate(invoice.paidAt)}` : "")));
    const covered = invoice.items.flatMap((i) => i.timerIds || []);
    if (covered.length) emit(paint("dim", `covers ${covered.length} timer entries`));
  },

  render({ positional, flags, file }) {
    const store = read(file);
    const invoice = findInvoice(store, positional[0] || flags.number);
    if (!invoice) throw new NotFoundError(`no invoice "${positional[0] || flags.number || ""}"`);
    const client = store.clients.find((c) => c.id === invoice.clientId) || null;
    const format = String(flags.format || "md").toLowerCase();
    let text;
    try {
      text = render(invoice, { format, business: store.business, client });
    } catch (err) { throw new UsageError(err.message); }

    if (flags.out) {
      fs.writeFileSync(flags.out, text);
      if (flags.json) return emitJson({ rendered: invoice.number, format, out: flags.out });
      if (!flags.quiet) warn(`wrote ${invoice.number} to ${flags.out}`);
      return;
    }
    // --json --format html would be two documents on stdout, so the flags are
    // resolved in favour of the explicit one: --format wins, and --json only
    // means "the json format" when no other was named.
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  },

  mark({ positional, flags, file }) {
    const target = String(positional[1] || flags.status || "").toLowerCase();
    if (!STATUSES.includes(target)) {
      throw new UsageError(`billing invoice mark <number> <${STATUSES.join("|")}>`);
    }
    const now = new Date();
    const at = flags.at ? parseMoment(flags.at, { now }) : now.toISOString();
    if (flags.at && !at) throw new UsageError(`--at: cannot read "${flags.at}" as a date`);

    const invoice = update((store) => {
      const found = findInvoice(store, positional[0] || flags.number);
      if (!found) throw new NotFoundError(`no invoice "${positional[0] || flags.number || ""}"`);
      if (found.status === target) return found;
      if (!canTransition(found.status, target)) {
        throw new UsageError(`cannot move ${found.number} from ${found.status} to ${target}`);
      }
      if (target === "sent") { found.sentAt = at; found.paidAt = null; }
      if (target === "paid") {
        found.paidAt = at;
        found.sentAt = found.sentAt || at;
        if (flags.amount != null) {
          const paid = parseMoney(flags.amount, found.currency);
          if (paid == null) throw new UsageError(`--amount: "${flags.amount}" is not an amount`);
          found.amountPaid = paid;
          // A part payment is not a paid invoice. Saying so here is the whole
          // reason --amount exists: otherwise the balance silently reads zero.
          if (paid < found.total) {
            found.status = "sent";
            recompute(found);
            return found;
          }
        } else found.amountPaid = found.total;
      }
      if (target === "draft") { found.sentAt = null; found.paidAt = null; found.amountPaid = 0; }
      if (target === "void") { found.paidAt = null; found.amountPaid = 0; }
      found.status = target;
      recompute(found);
      return found;
    }, { file });

    if (flags.json) return emitJson({ invoice: serializeInvoice(invoice, now) });
    if (!flags.quiet) {
      const state = effectiveStatus(invoice, now);
      emit(`${paint("green", state)} ${invoice.number}  ${formatMoney(invoice.total, invoice.currency)}`
        + (invoice.amountPaid && invoice.amountPaid < invoice.total
          ? paint("yellow", `  part paid — ${formatMoney(invoice.total - invoice.amountPaid, invoice.currency)} still due`)
          : ""));
    }
  },

  edit({ positional, flags, file }) {
    const now = new Date();
    const invoice = update((store) => {
      const found = findInvoice(store, positional[0] || flags.number);
      if (!found) throw new NotFoundError(`no invoice "${positional[0] || flags.number || ""}"`);
      if (found.status === "paid" && !flags.force) {
        throw new UsageError(`${found.number} is paid — editing it changes a settled record; pass --force if you mean it`);
      }
      if (flags.currency) found.currency = String(flags.currency).toUpperCase();
      if (flags.note != null) found.notes = String(flags.note);
      if (flags.po != null) found.poNumber = String(flags.po);
      if (flags.tax != null) {
        const tax = Number(flags.tax);
        if (!Number.isFinite(tax)) throw new UsageError(`--tax: "${flags.tax}" is not a percentage`);
        found.taxRate = tax;
      }
      if (flags.due != null) {
        const due = parseMoment(flags.due, { now });
        if (!due) throw new UsageError(`--due: cannot read "${flags.due}" as a date`);
        found.dueAt = due;
      }
      if (flags.terms != null) found.dueAt = dueFrom(found.issuedAt, flags.terms);
      if (flags["rm-item"]) {
        const ref = String(flags["rm-item"]);
        const index = /^\d+$/.test(ref) ? Number(ref) - 1 : found.items.findIndex((i) => i.id === ref);
        if (index < 0 || index >= found.items.length) throw new NotFoundError(`${found.number} has no line item "${ref}"`);
        found.items.splice(index, 1);
      }
      for (const spec of flags.item || []) found.items.push(makeItem(parseItemSpec(spec, found.currency)));
      if (!found.items.length) throw new UsageError(`that would leave ${found.number} with no line items — delete it instead`);
      recompute(found);
      return found;
    }, { file });

    if (flags.json) return emitJson({ invoice: serializeInvoice(invoice, now) });
    if (!flags.quiet) emit(`${paint("green", "updated")} ${invoice.number}  ${formatMoney(invoice.total, invoice.currency)}`);
  },

  rm({ positional, flags, file }) {
    const invoice = update((store) => {
      const found = findInvoice(store, positional[0] || flags.number);
      if (!found) throw new NotFoundError(`no invoice "${positional[0] || flags.number || ""}"`);
      if (found.status !== "draft" && !flags.force) {
        throw new UsageError(
          `${found.number} is ${found.status} — deleting it leaves a hole in the numbering.`
          + ` Void it instead (billing invoice mark ${found.number} void), or pass --force.`,
        );
      }
      store.invoices.splice(store.invoices.indexOf(found), 1);
      return found;
    }, { file });
    if (flags.json) return emitJson({ removed: serializeInvoice(invoice) });
    if (!flags.quiet) {
      emit(`${paint("red", "removed")} ${invoice.number}`);
      const freed = invoice.items.flatMap((i) => i.timerIds || []).length;
      if (freed) emit(paint("dim", `${freed} timer entries are billable again`));
    }
  },
};

// ---------------------------------------------------------------------------

const BY_NAME = new Map();
for (const cmd of COMMANDS) {
  BY_NAME.set(cmd.name, cmd);
  for (const alias of cmd.aliases || []) BY_NAME.set(alias, cmd);
}

export function findCommand(name) {
  return BY_NAME.get(String(name || "").toLowerCase()) || null;
}

function usage() {
  const lines = [
    `${paint("bold", "billing")} — clients, rates and invoices, for people and for agents`,
    "",
    "  billing <command> [args] [--json]",
    "",
  ];
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const c of COMMANDS) lines.push(`  ${c.name.padEnd(width)}  ${c.summary}`);
  lines.push(
    "",
    "  billing help <command>   flags and examples for one command",
    "",
    paint("dim", "  --json on any command prints one JSON document and nothing else."),
    paint("dim", `  ledger: ${dataFile()}`),
  );
  return lines.join("\n");
}

function commandHelp(cmd) {
  const flagList = [
    ...(cmd.booleans || []).map((f) => `--${f}`),
    ...(cmd.values || []).map((f) => `--${f} <value>`),
    ...(cmd.multi || []).map((f) => `--${f} <value>  (repeatable)`),
  ];
  const lines = [`${paint("bold", `billing ${cmd.name}`)} ${cmd.args || ""}`.trimEnd(), "", `  ${cmd.summary}`];
  if (cmd.aliases?.length) lines.push("", `  aliases: ${cmd.aliases.join(", ")}`);
  if (flagList.length) lines.push("", "  flags:", ...flagList.map((f) => `    ${f}`));
  if (cmd.detail?.length) lines.push("", ...cmd.detail.map((l) => (l ? `  ${l}` : "")));
  lines.push("", "  global: --json  --quiet  --data <file>  --help  --version");
  return lines.join("\n");
}

export function run(argv) {
  const head = parseArgs(argv, {
    booleans: GLOBAL_BOOLEANS,
    values: GLOBAL_VALUES,
    aliases: GLOBAL_ALIASES,
  });
  if (head.flags.version) { emit(VERSION); return 0; }

  const name = head.positional[0];
  if (!name || name === "help") {
    const topic = name === "help" ? head.positional[1] : null;
    if (topic) {
      const cmd = findCommand(topic);
      if (!cmd) throw new UsageError(`unknown command "${topic}"`);
      emit(commandHelp(cmd));
      return 0;
    }
    emit(usage());
    return 0;
  }

  const cmd = findCommand(name);
  if (!cmd) throw new UsageError(`unknown command "${name}" — try: billing help`);
  if (head.flags.help) { emit(commandHelp(cmd)); return 0; }

  const parsed = parseArgs(argv.slice(argv.indexOf(name) + 1), {
    booleans: [...GLOBAL_BOOLEANS, ...(cmd.booleans || [])],
    values: [...GLOBAL_VALUES, ...(cmd.values || [])],
    multi: cmd.multi || [],
    aliases: GLOBAL_ALIASES,
  });
  if (parsed.flags.help) { emit(commandHelp(cmd)); return 0; }
  if (parsed.unknown.length) {
    throw new UsageError(`unknown flag ${parsed.unknown[0]} for "${cmd.name}" — try: billing help ${cmd.name}`);
  }
  const flags = { ...head.flags, ...parsed.flags };
  delete flags.help;
  delete flags.version;
  const file = flags.data || dataFile();
  cmd.run({ positional: parsed.positional, flags, rest: parsed.rest, file });
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    return run(argv);
  } catch (err) {
    const code = err.exitCode || 1;
    if (argv.includes("--json") || argv.includes("-j")) {
      process.stderr.write(`${JSON.stringify({ error: err.message, kind: err.name || "Error" }, null, 2)}\n`);
    } else {
      warn(`${paint("red", "billing:")} ${err.message}`);
    }
    return code;
  }
}
