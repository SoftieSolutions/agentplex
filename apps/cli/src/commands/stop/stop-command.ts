import { lookupUsageLines } from '../../installation/lookup-flags.js';
import type { UnitsCommand } from '../../installation/units-command.js';
import { stopUnits } from '../../installation/units.js';

/**
 * `agentplex stop`: off now, and off at the next boot.
 *
 * It disables as well as stopping, which is the whole of why it is the reverse
 * of `agentplex start` rather than a spelling of `systemctl stop`. That one is
 * still there, and is still the right thing for a single restart.
 */
const USAGE = [
  'Usage: agentplex stop [options]',
  '',
  '  Stops every agentplex unit this machine has and takes it off boot, in the scope',
  '  it was installed in. It is the exact reverse of agentplex start, which is why',
  '  it disables as well as stops. `systemctl stop` is still there for one restart.',
  '',
  '  Which prefix and which scope come from the settings file install.sh wrote:',
  '  a machine with no such file is not one this can act on, and says so.',
  '',
  ...lookupUsageLines(),
].join('\n');

export const STOP: UnitsCommand = { name: 'stop', usage: USAGE, act: stopUnits };
