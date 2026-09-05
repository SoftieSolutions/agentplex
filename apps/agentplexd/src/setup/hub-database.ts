import type { Queryable } from '../hub/db/database.js';

/**
 * The hub's database, opened by setup for exactly as long as one write takes.
 *
 * `--role=both` is the only thing that needs this: the hub's end of a pairing is
 * a row, and setup writes both ends. Everywhere else setup opens no database at
 * all, which is why this is a seam handed to one front end rather than something
 * the command reaches for.
 *
 * **Scoped rather than open-and-close.** Setup is a program that exits, and a
 * SQLite handle left open holds WAL files beside the database and the event loop
 * open under the wizard. Whoever opens it closes it, and a body that throws
 * still gives it back.
 *
 * **Migrated on the way in.** The row goes into a table, and on a machine being
 * set up for the first time there is no file yet, let alone a table. Setup and
 * the hub are the same binary, so the schema this brings the file to is the one
 * the hub will read it back with; a hub started against it afterwards finds its
 * migrations already applied and says so.
 *
 * The path is never in a `SetupPlan`. That is what keeps the exception this seam
 * exists for interactive: a replay has no database to name, so `applySetupPlan`
 * has nothing to write a pairing into and no parameter through which one could
 * arrive.
 */
export interface HubDatabase {
  /**
   * Opens the hub database at `path`, brings it up to this build's schema, hands
   * it to `body`, and closes it again.
   *
   * Never rejects: a database that cannot be opened is a fact about the machine
   * the operator has to be told, in the same shape as everything else setup
   * reports.
   */
  withDatabase<T>(
    path: string,
    body: (database: Queryable) => Promise<T>,
  ): Promise<HubDatabaseResult<T>>;
}

export type HubDatabaseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };
