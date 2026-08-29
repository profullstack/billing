# billing

Clients, rates and invoices from the terminal, on Linux, macOS and Windows.

It turns tracked hours into an invoice you can send. Pair it with
[`@profullstack/timer`](https://github.com/profullstack/timer) and the loop is
`timer start` to `billing invoice new --from-timer` to a PDF in the client's
inbox. Every command also speaks `--json`, so an agent can prepare an invoice
and hand it to you to send.

```sh
npm install -g @profullstack/billing
```

Node 20.11 or newer. No runtime dependencies.

## The loop

```sh
billing init --name "Your Company" --email you@example.com --rate 150 --terms 14
billing client add acme --display "Acme Corp" --email ap@acme.com --rate 175

timer start acme fix the login redirect     # ... work happens ...
timer stop

billing hours --client acme --month                    # what is billable
billing invoice new --client acme --from-timer --month # make the invoice
billing invoice render INV-0001 --format html --out acme-august.html
billing invoice mark INV-0001 sent
billing invoice mark INV-0001 paid
```

Open the HTML in a browser and print to PDF. It is a single self-contained
file: no stylesheet, font or image is fetched, so it renders the same offline,
as an email attachment, and in print.

## Commands

| Command | What it does |
| --- | --- |
| `init` | Set the business on the invoices. Only the fields you pass change |
| `client add\|list\|show\|set\|rm\|archive` | Who you bill, and on what terms |
| `hours --client <c>` | Tracked hours not yet on an invoice |
| `invoice new` | Create one, from tracked time or from `--item` lines |
| `invoice list` | Filter by `--client`, `--status`, `--overdue`, a window |
| `invoice show <n>` | Read one in the terminal |
| `invoice render <n>` | `--format md\|html\|txt\|json`, `--out <file>` |
| `invoice mark <n> <status>` | `draft`, `sent`, `paid`, `void`; `--amount` for a part payment |
| `invoice edit <n>` | Add or remove line items, change tax, terms, notes |
| `invoice rm <n>` | Delete a draft (`--force` for anything else) |
| `report` | Billed, collected, outstanding, overdue, by client |
| `config` | Where the ledger and the timesheet live |

`billing help <command>` prints the flags and examples for one command.

## Billing tracked time

`--from-timer` reads the timesheet directly — `timer` does not need to be on
`PATH` — and applies four rules:

- **The client's projects.** With no `--project` set, a client bills the timer
  project matching its own handle, so `timer start acme` and `billing client
  add acme` line up with nothing to configure.
- **The window**, compared against each entry's start, `--until` exclusive.
  The same rule `timer` uses, so the two tools always agree about which day an
  entry belongs to.
- **Billable and finished only.** A running clock is left out on purpose: its
  duration is still changing, and a line that would have been different a
  minute later is not a line you can send. `--include-running` overrides it.
- **Not already billed.** Every invoice records the timer entry ids it covers,
  so the same hour cannot reach two invoices.

Nothing is written back to the timesheet. Void or delete an invoice and its
hours are billable again, with nothing to un-mark.

### How the hours become lines

`--group` decides: `task` (the default), `project`, `day`, `tag` or `entry`.

Rate is part of the grouping, not just the label. Two entries on the same task
at different rates stay two lines, because collapsing them would invent a
blended rate that appears nowhere in the record and that the client cannot
check. An entry's own rate (`timer start acme --rate 200`) always beats the
client's.

## Fixed line items

An invoice does not need a timesheet at all:

```sh
billing invoice new --client acme \
  --item "August retainer|1|2500" \
  --item "Rush fee|2|250" \
  --tax 8.25 --terms 30
```

The form is `"description|quantity|price"`, or `"description|price"` for a
quantity of one. Both kinds of line can appear on the same invoice.

## Money

Every amount is stored as an integer count of the currency's smallest unit, and
rounding happens once per line. The printed lines add up to the printed
subtotal — which is not true if you round only at the end, and is the first
thing a client's accounts department checks.

Currencies with other minor units are handled without a lookup table: `JPY` has
no decimal places and `KWD` has three, and both come out right.

## Numbers and status

Invoice numbers are `INV-0001`, zero-padded so they sort as plain strings. The
next number is derived from the highest one in use, not only from a counter, so
a hand-edited or imported ledger cannot cause a collision — and a deleted
number is never reused.

`void` is how you retire an invoice that has already gone out: it keeps its
number, so the sequence has no holes to explain, but releases the hours it
covered. `overdue` is derived from the due date, never stored.

## For agents

`--json` works on every command and prints a single JSON document on stdout,
nothing else. A failed command prints its error as JSON on **stderr** and
leaves stdout empty. Exit codes: `0` success, `1` runtime failure, `2` bad
command line, `3` you named something that is not there.

`--dry-run` on `invoice new` builds and validates the whole invoice, prints
what it would create, and writes nothing — the safe way for an agent to propose
an invoice for a person to approve.

```sh
billing hours --client acme --month --json
billing invoice new --client acme --from-timer --month --dry-run --json
```

More in [AGENTS.md](AGENTS.md).

## Where the data lives

```
~/.profullstack/billing/ledger.json     the business, clients and invoices
~/.profullstack/timer/timesheet.json    the hours, written by @profullstack/timer
```

| Variable | Overrides |
| --- | --- |
| `BILLING_DATA` | the ledger file |
| `BILLING_HOME` | the directory it sits in |
| `TIMER_DATA` | the timesheet to bill from (also `--timer-data`) |
| `PROFULLSTACK_HOME` | the parent shared with other Profullstack CLIs |
| `NO_COLOR` | turns off colour |

`billing config` prints all of it. Writes are atomic and locked, so two
processes cannot issue the same invoice number.

## In moshcode

[moshcode](https://github.com/moshcoder/moshcode) installs and fronts it:

```
moshcode install billing
/billing hours --client acme --month
```

## Licence

MIT © Profullstack, LLC
