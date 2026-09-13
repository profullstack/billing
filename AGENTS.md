# billing, for agents

`billing` turns tracked hours into invoices. This file is the contract for
driving it from a program.

## The rules

1. **`--json` works on every command.** One JSON document on stdout, nothing
   else.
2. **A failed run prints nothing on stdout.** The error goes to stderr as
   `{"error": "...", "kind": "..."}`.
3. **Exit codes mean something.**

   | Code | Meaning |
   | --- | --- |
   | 0 | success |
   | 1 | runtime failure |
   | 2 | bad command line, or a refused operation (editing a paid invoice, deleting a sent one) |
   | 3 | you named a client or invoice that does not exist, or there were no unbilled hours |

4. **An unknown flag is an error**, never silently ignored.

## Propose, do not send

Creating an invoice is a business action. The intended agent flow is to prepare
one and let a person approve it:

```sh
billing hours --client acme --month --json
billing invoice new --client acme --from-timer --month --dry-run --json
```

`--dry-run` builds and validates the entire invoice — including the rate lookup
and the double-billing check — prints it under `wouldCreate`, and writes
nothing. A dry run that succeeds means the real command will succeed.

Drop `--dry-run` to write it. It is created as a **draft**; `billing invoice
mark <n> sent` is a separate, deliberate step, and this tool never emails
anything.

## Which hours are billable

`billing hours --client <c> --json` answers exactly what `invoice new
--from-timer` would bill, and reports what it left out:

```json
{
  "client": "acme",
  "projects": ["acme"],
  "currency": "USD",
  "items": [{ "description": "auth refactor", "quantity": 5.5, "unitPriceMajor": 175, "amount": 962.5, "timerIds": ["4f2a", "8b1c"] }],
  "hours": 6.75,
  "subtotal": 1181.25,
  "skipped": { "running": 1, "unbillable": 1, "alreadyBilled": 0 }
}
```

`skipped.running` is the one to read back to a person: those hours become
billable as soon as the clock is stopped, so "nothing to bill" may just mean
"the clock is still running".

## Rates and agent-hours

A rate is a parsed sentence, not a number:

```sh
billing rate set acme '$400/hour/agent/upto:4' --json
billing rate show acme --json
```

```json
{
  "target": "acme", "minor": 40000, "currency": "USD", "per": "hour",
  "unit": "agent", "cap": 4, "min": null, "amount": 400,
  "text": "$400.00/hour/agent/upto:4",
  "describes": "$400.00 per hour per agent, billing at most 4 agents"
}
```

When `unit` is not `flat`, line items are billed in **agent-hours** (or
seat-days, etc.) and `quantity * unitPrice` reproduces `amount` exactly. Each
timer entry is charged with its own agent count before the units are summed, so
a mixed day is never billed at a single averaged count.

`timer` records the count: `timer start acme --agents 4`.

## Amounts

`--json` reports money twice. The raw fields (`subtotal`, `tax`, `total`) are
integers in the currency's minor units; the `amounts` object is the same
figures as decimal numbers:

```json
{ "total": 118125, "amounts": { "total": 1181.25, "balance": 1181.25 } }
```

Use `amounts` for anything you show a person. Use the integers if you do
arithmetic, and do not convert to a float in between.

## The ledger

Plain JSON at `~/.profullstack/billing/ledger.json` (or `$BILLING_DATA`):

```json
{ "version": 1, "business": {}, "clients": [], "invoices": [], "counter": 0 }
```

Read it if you like; write it through the CLI. Writes are locked, and a write
that races an invoice creation can issue a duplicate invoice number.

## Windows

`--today`, `--yesterday`, `--week`, `--month`, `--year`, or `--since` /
`--until`. Bounds compare against the entry's start (for hours) or the issue
date (for invoices and reports), and `--until` is exclusive. Dates accept
`2026-08-01`, `-30d`, `yesterday` or a full ISO instant.
