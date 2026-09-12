import { lookupUsageLines } from '../../installation/lookup-flags.js';
import type { UnitsCommand } from '../../installation/units-command.js';
import { startUnits } from '../../installation/units.js';

/**
 * `agentplex start`: on at boot, and running now.
 *
 * The usage is a literal because it is prose. It used to be woven out of the
 * other command's with a ternary per line, which kept the two paragraphs the
 * same length and made neither of them readable -- and the thing that has to
 * stay in step between `start` and `stop` was never the wording. It is the list
 * of units, and that is `units.js`, one list read once and acted on by
 * `startUnits` and `stopUnits` alike.
 */
const USAGE = [
  'Usage: agentplex start [options]',
  '',
  '  Enables and starts every agentplex unit this machine has, in the scope it was',
  '  installed in. It supervises nothing itself: systemd runs the daemons, and this',
  '  is the command that saves you knowing which systemctl reaches them.',
  '',
  '  Which prefix and which scope come from the settings file install.sh wrote:',
  '  a machine with no such file is not one this can act on, and says so.',
  '',
  ...lookupUsageLines(),
].join('\n');

export const START: UnitsCommand = { name: 'start', usage: USAGE, act: startUnits };
