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
billing init --name "Your Company" --email you@example.com --terms 14
billing client add acme --display "Acme Corp" --email ap@acme.com
billing rate set acme '$100/hour/agent/upto:4' 

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
| `rate set\|list\|show\|rm` | What your time costs, in the words of the contract |
| `hours --client <c>` | Tracked hours not yet on an invoice |
| `invoice new` | Create one, from tracked time or from `--item` lines |
| `invoice list` | Filter by `--client`, `--status`, `--overdue`, a window |
| `invoice show <n>` | Read one in the terminal |
| `invoice render <n>` | `--format md\|html\|txt\|json`, `--out <file>` |
| `invoice mark <n> <status>` | `draft`, `sent`, `paid`, `void`; `--amount` for a part payment |
| `invoice edit <n>` | Add or remove line items, change tax, terms, notes |
| `invoice rm <n>` | Delete a draft (`--force` for anything else) |
| `report` | Billed, collected, outstanding, overdue, by client |
| `import` | Bring across a ledger that started inside moshcode |
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

## Clients

Contact details are written the way they arrive:

```sh
billing client add "Acme Inc", https://acme.com, +1-555-0100
billing client add acme --contact.telephone +1-555-0100 --contact.name Jane
billing client payee acme solana:9xQe...
```

The comma form is what you paste out of a signature: the first segment is the
name and the rest are recognised **by shape, in any order**, because nobody's
signature comes in a fixed one. A segment nothing recognises is kept as a note
rather than dropped.

Any dotted flag sets that path. `--billing.po` works because it says what it
means — there is no field list to be missing from, so a record grows the fields
your business actually keeps. Setting one path merges; it never drops the
others. (An *undotted* unknown flag is still an error, so a typo is a typo.)

`payee` is where a client's payments land. It is recorded, never guessed: a bare
address with no `chain:` prefix and no `--chain` is filed as `unknown` rather
than assumed, and `client payee acme` with no address is refused rather than
clearing the one that is there. `invoice render --format json` carries it, which
is how an outside payment rail asks where to settle.

## Rates

A rate is the sentence from the contract, parsed:

```sh
billing rate set default '$150/hour'
billing rate set acme    '$100/hour/agent/upto:4'
billing rate set beta    '0.5 SOL/day' --prefer SOL --accept fiat
billing rate set gamma   '$5000/project'
```

One line carrying four decisions: the price, the period it is charged for, the
thing that gets multiplied, and the point past which you stop charging.
`$100/hour/agent/upto:4` means four agents cost four hundred an hour, and so do
six. Order does not matter after the price, because nobody remembers an order
they were never told.

- **Periods**: `hour`, `day` (8h), `week` (40h), `month` (160h), `project`, `task`
- **Units**: `agent`, `seat`, `person`, `team`, or flat when you omit it
- **`upto:N`** caps the multiplier, **`min:N`** sets a minimum billed period

`default` is a real target: a solo shop has one number everybody pays, and a
per-client rate is what happens the first time somebody negotiates.

### Agent-hours

When a rate is priced per agent, the invoice bills **agent-hours**, because that
is arithmetic a client can check:

```
auth refactor    14 agent-hours @ $100.00    $1,400.00
```

Three hours with two agents plus two hours with six (capped at four) is 14
agent-hours. Each entry is charged on its own and the units are then summed,
never the other way round: averaging the agent count would bill a two-agent
afternoon at the four-agent rate.

`quantity x unitPrice` always reproduces the line amount exactly. That property
is worth the one rounding it costs.

### Settlement is not the price

`--prefer SOL --accept fiat` records how you would like to be paid. It is
deliberately separate from the rate: the number in the contract does not change
because the rail did. A price given in a ticker (`0.5 SOL/day`, `250 USDC/task`)
invoices in that ticker, carried to 8 decimal places and printed as a quantity
rather than run through a currency formatter that would render "USDC 250.00".

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

## Coming from moshcode

moshcode used to keep this layer internally, in `~/.moshcode/business.json` and
`~/.moshcode/timers.json`. Bring it across:

```sh
billing import              # shows the plan, writes nothing
billing import --apply
```

Clients, rates, invoices and the tracked entries all come over, and the agent
count survives. A client that already exists here is left alone rather than
merged, and the moshcode files are never modified — if the mapping turns out to
be wrong, the originals are still there.

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
