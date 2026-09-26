import { unitFile, type Layout } from './layout.js';
import { renderUnit, unitFileName, type Daemon } from './unit-file.js';
import type { WriteMachine } from './write-machine.js';

/**
 * One daemon's unit, written: `write_units`' `mkdir -p "$UNIT_DIR"` and
 * `render_unit "$daemon" >"$file"`.
 *
 * The bytes are `renderUnit`'s and nothing else, so what an install leaves on
 * disk is what `--print-unit` prints and what the captured fixtures hold. The
 * decisions around it -- that an existing unit is left alone, that none is
 * written on a machine with no systemd, that a written unit is never enabled
 * -- are the install's, which asks before it calls this.
 */
export async function writeUnit(
  daemon: Daemon,
  layout: Layout,
  nodeDirectory: string,
  machine: Pick<WriteMachine, 'makeDirectory' | 'writeFile'>,
): Promise<
  { readonly ok: true; readonly file: string } | { readonly ok: false; readonly problem: string }
> {
  const made = await machine.makeDirectory(layout.unitDirectory);
  if (!made.ok) return made;
  const file = unitFile(layout, unitFileName(daemon));
  const written = await machine.writeFile(file, renderUnit(daemon, layout, nodeDirectory));
  return written.ok ? { ok: true, file } : written;
}
