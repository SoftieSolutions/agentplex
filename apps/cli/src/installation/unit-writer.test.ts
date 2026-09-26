import { describe, expect, it } from 'vitest';
import { createFakeWriteMachine } from './fake-write-machine.js';
import { systemLayout, userLayout } from './layout.js';
import { renderUnit } from './unit-file.js';
import { writeUnit } from './unit-writer.js';

/**
 * The unit an install writes is the unit `--print-unit` prints: the writer adds
 * a directory and a file around `renderUnit`'s bytes and nothing else, so the
 * fixtures that hold the renderer against `install.sh` hold what lands on disk
 * too.
 */

const HOME = '/home/alice';
const NODE = `${HOME}/.agentplex/node/bin`;

describe('writeUnit', () => {
  it("writes renderUnit's bytes, making the unit directory first", async () => {
    const layout = userLayout(HOME);
    const machine = createFakeWriteMachine();

    const written = await writeUnit('server', layout, NODE, machine);

    const file = `${HOME}/.config/systemd/user/agentplex-server.service`;
    expect(written).toEqual({ ok: true, file });
    expect(machine.acts).toEqual([`mkdir ${HOME}/.config/systemd/user`, `write ${file}`]);
    expect(machine.contents.get(file)).toBe(renderUnit('server', layout, NODE));
  });

  it('writes the fleet unit into the system directory', async () => {
    const layout = systemLayout();
    const machine = createFakeWriteMachine();

    await writeUnit('hub', layout, '/opt/agentplex/node/bin', machine);

    expect(machine.contents.get('/etc/systemd/system/agentplex-hub.service')).toBe(
      renderUnit('hub', layout, '/opt/agentplex/node/bin'),
    );
  });

  it('writes nothing when the directory cannot be made, and says why', async () => {
    const machine = createFakeWriteMachine({
      unwritable: { [`${HOME}/.config/systemd/user`]: 'EACCES: permission denied' },
    });

    const written = await writeUnit('hub', userLayout(HOME), NODE, machine);

    expect(written).toEqual({ ok: false, problem: 'EACCES: permission denied' });
    expect(machine.acts).toEqual([`mkdir ${HOME}/.config/systemd/user`]);
  });
});
