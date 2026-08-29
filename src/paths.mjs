// Where the ledger lives, and where to find the timesheet it bills from.
//
// Same reasoning as @profullstack/timer: one documented path on all three
// platforms beats OS convention when the file is a contract other tools read.
import { homedir } from "node:os";
import path from "node:path";

export function profullstackHome() {
  return process.env.PROFULLSTACK_HOME || path.join(homedir(), ".profullstack");
}

export function billingHome() {
  return process.env.BILLING_HOME || path.join(profullstackHome(), "billing");
}

/** The ledger: business profile, clients and invoices, in one file. */
export function dataFile() {
  return process.env.BILLING_DATA || path.join(billingHome(), "ledger.json");
}

/**
 * The timesheet @profullstack/timer writes.
 *
 * Resolved by path rather than by running `timer`, deliberately: billing works
 * on a machine where timer is not installed, or is installed for a different
 * Node, and reading a file cannot half-succeed the way spawning a child can.
 * The precedence matches timer's own, so a redirected timesheet stays
 * redirected for both tools.
 */
export function timerDataFile() {
  if (process.env.TIMER_DATA) return process.env.TIMER_DATA;
  const home = process.env.TIMER_HOME || path.join(profullstackHome(), "timer");
  return path.join(home, "timesheet.json");
}
