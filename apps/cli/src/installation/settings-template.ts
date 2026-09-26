import { join } from 'node:path';
import { CLI_COMMAND } from './components.js';
import { binDirectory, stateDirectory, type Layout } from './layout.js';
import { DOCS_URL } from './unit-file.js';

/**
 * The settings file an install writes once: `install.sh`'s
 * `write_environment_file`, restated in the program that takes the install
 * over.
 *
 * Restated rather than shared, for the reason the unit renderer gives: the
 * installer is a shell script with nothing to import. What holds the two
 * together is `settings-template.test.ts`, which compares this text byte for
 * byte with files the script wrote on machines it really installed, captured
 * under `fixtures/settings/`. Every comment in the file is the script's, word
 * for word -- including the sentence that says `install.sh` wrote it, which
 * changes when the script stops being the writer and not before.
 *
 * Only the text is here. Writing it once and never again, the mode it is
 * created with and the owner it ends with are the install's, because they are
 * about the machine and this is a pure function of the layout.
 */

/** What `AGENTPLEX_ROLE` records: the word for the machine, never its pins. */
export type Role = 'hub' | 'server' | 'both';

/**
 * The file's text for one role in one layout.
 *
 * The server's identity line is commented on a per-user install and set on
 * `--system`, for the reason the script gives: on a per-user install setup
 * mints the file and records the path it minted, while the fleet tier's
 * account has the state directory as its home, where the server's own default
 * would be a file nothing mints. Written whatever the role, because the file
 * is written once and a hub that later runs a server beside it should not have
 * to learn this line then.
 */
export function renderSettings(role: Role, layout: Layout): string {
  const state = stateDirectory(layout);
  const identity = `AGENTPLEX_SERVER_IDENTITY_FILE=${join(state, 'server.json')}`;
  return [
    '# agentplex settings, read by the systemd units as an EnvironmentFile. Both',
    '# daemons read this one file, and each reads only the keys it needs.',
    '#',
    '# install.sh wrote this file once and will not touch it again. Three lines are',
    '# uncommented because they are the three facts the installer had: the role you',
    '# asked for, the prefix it created, and the bin path inside it -- and on a',
    "# --system install a fourth, the server's identity file. The rest is",
    '# commented out because guessing a database path or a store path is worse than',
    `# leaving one absent -- fill them in, or let \`${CLI_COMMAND} setup\` do it.`,
    '#',
    '# Every setting here has a flag as well, and the flag wins. The whole table is',
    `# at ${DOCS_URL}`,
    '',
    `AGENTPLEX_ROLE=${role}`,
    '',
    '# The prefix this install created, recorded so that it can be given back. No',
    '# daemon reads this line: it is here for the person who runs',
    `# \`${CLI_COMMAND} setup --prefix=$AGENTPLEX_PREFIX\` on this machine later, and`,
    '# for whoever is reading the file to find out where everything went. A setup run',
    '# that is not told owns $HOME/.agentplex instead, which on a machine installed',
    '# anywhere else is a second prefix nothing points at.',
    `AGENTPLEX_PREFIX=${layout.prefix}`,
    '',
    '# Where agent binaries are looked for, ahead of the PATH this service inherits.',
    '# A systemd unit gets a minimal PATH with no version-manager shims in it, so a',
    '# `claude` that resolves in your shell does not resolve here; recording the',
    "# directory is what makes that stop mattering. Separate several with ':'.",
    `AGENTPLEX_BIN_PATH=${binDirectory(layout)}`,
    '',
    "# The hub's half. Both are required for role=hub and role=both.",
    `#AGENTPLEX_DATABASE_FILE=${join(state, 'hub.sqlite')}`,
    '#AGENTPLEX_CLIENT_TOKEN=',
    '',
    '# The server beside the hub, for role=both: the hub pairs it at boot from the',
    `# token in that identity file, so nobody types one. \`${CLI_COMMAND} setup\``,
    '# fills these in.',
    `#AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE=${join(state, 'server.json')}`,
    '#AGENTPLEX_LOCAL_SERVER_PORT=8081',
    '',
    "# The server's half. The identity file holds this server's identity and the",
    `# pairing token; \`${CLI_COMMAND} setup\` records here the one it mints. Unset,`,
    '# the server keeps it at $HOME/.agentplex/server.json. Store paths are',
    "# absolute and ':'-separated.",
    layout.scope === 'system' ? identity : `#${identity}`,
    '#AGENTPLEX_STORE_PATH=',
    '',
    '# The directories a client may browse when somebody picks a project on this',
    "# machine. Absolute and ':'-separated, like the store paths. Anything under one",
    '# of these can be listed by a client of any hub this server is paired with, and',
    '# nothing else can. Unset means this server lists no directory at all, which is',
    `# the default: \`${CLI_COMMAND} setup\` asks before it writes one.`,
    '#AGENTPLEX_BROWSE_ROOTS=',
    '',
    '#AGENTPLEX_HOST=127.0.0.1',
    '#AGENTPLEX_HUB_PORT=8080',
    '#AGENTPLEX_SERVER_PORT=8081',
    '#AGENTPLEX_LOG_LEVEL=info',
    '',
  ].join('\n');
}
