import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "billing.mjs");

/** A throwaway ledger and timesheet, so no test can touch a real one. */
export function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "billing-test-"));
  return {
    dir,
    file: path.join(dir, "ledger.json"),
    timer: path.join(dir, "timesheet.json"),
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Write a timesheet in the shape @profullstack/timer produces. Kept here
 * rather than shelling out to timer so the suite has no dependency on timer
 * being installed — the contract under test is the file format, not the tool.
 */
export function writeTimesheet(file, entries) {
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    entries: entries.map((e, i) => ({
      id: e.id || `entry${i}`,
      project: e.project || "acme",
      task: e.task || "",
      tags: e.tags || [],
      start: e.start,
      end: e.end === undefined ? null : e.end,
      notes: "",
      agent: e.agent || null,
      rate: e.rate === undefined ? null : e.rate,
      billable: e.billable !== false,
      meta: {},
    })),
  }, null, 2));
}

export function cli(args, { file, timer, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        BILLING_DATA: file,
        TIMER_DATA: timer || path.join(path.dirname(file), "no-timesheet.json"),
        NO_COLOR: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

export function json(args, opts) {
  const res = cli([...args, "--json"], opts);
  return { ...res, data: res.stdout.trim() ? JSON.parse(res.stdout) : null };
}

/** A ledger with a business and one client, which most tests need. */
export function seeded(opts, { rate = "150" } = {}) {
  cli(["init", "--name", "Test Co", "--email", "billing@test.co", "--currency", "USD", "--terms", "14"], opts);
  cli(["client", "add", "acme", "--display", "Acme Corp", "--email", "ap@acme.com", "--rate", rate], opts);
}
