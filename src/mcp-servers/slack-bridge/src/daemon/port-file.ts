/**
 * Daemon port file helpers — REQ-007.
 *
 * writePortFile  — writes the port before api.listen() and again in the callback.
 * cleanupPortFile — called in SIGINT, SIGTERM and "exit" handlers.
 */

import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Name of the port file inside the state directory. */
const PORT_FILE = "daemon.port";

/**
 * Write the daemon's listening port to `${stateDir}/daemon.port`.
 * Creates stateDir (recursively) if it does not exist.
 * Overwrites any existing file so stale entries from dead daemons are replaced.
 * File is created with mode 0o600 (owner read/write only) to prevent
 * other local users from reading the daemon port.
 */
export function writePortFile(port: number, stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, PORT_FILE), String(port), { encoding: "utf8", mode: 0o600 });
}

/**
 * Remove `${stateDir}/daemon.port`.
 * Best-effort and idempotent — never throws even if the file is missing.
 */
export function cleanupPortFile(stateDir: string): void {
  try {
    unlinkSync(join(stateDir, PORT_FILE));
  } catch {
    /* best effort — file may not exist */
  }
}
