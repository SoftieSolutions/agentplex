import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRAIN_MS,
  DEFAULT_TERMINAL_CAP,
  HUB_SETTINGS,
  SERVER_SETTINGS,
  readAnnounce,
  readDataPath,
  readDrainSeconds,
  readHost,
  readIdentityPath,
  readLocalServer,
  readLogLevel,
  readServerToken,
  readTerminalCap,
  readTimezone,
} from './daemon-settings.js';

/**
 * The daemons' settings, parsed once for every program that reads them.
 *
 * These cases were the server's and the hub's, written against a whole
 * configuration. They are here because the parsers are: the server, the hub
 * and the doctor all read the same settings file, and a rule that lived in one
 * of three copies was a rule the other two could quietly disagree with. What a
 * daemon's own `config.test.ts` keeps is the end-to-end half -- that the
 * setting reaches its configuration at all.
 */

/** A reader's value and whatever it complained about, in one call. */
function parsed<T>(read: (problems: string[]) => T): { value: T; problems: string[] } {
  const problems: string[] = [];
  const value = read(problems);
  return { value, problems };
}

describe('the settings tables', () => {
  it('names each setting once per daemon, and the two share the ones they both read', () => {
    // One settings file, two programs. A key both read has one flag and one
    // variable between them, or `agentplex doctor` would have to accept two
    // spellings of the same line.
    expect(SERVER_SETTINGS.logLevel).toEqual(HUB_SETTINGS.logLevel);
    expect(SERVER_SETTINGS.host).toEqual(HUB_SETTINGS.host);
  });

  it('carries the data root, which the doctor has to be able to type too', () => {
    expect(SERVER_SETTINGS.dataPath).toEqual({ flag: '--data-path', env: 'AGENTPLEX_DATA_PATH' });
  });
});

describe('readLogLevel and readHost', () => {
  it('default to info and every interface', () => {
    expect(readLogLevel(undefined, [])).toBe('info');
    expect(readHost(undefined, [])).toBe('0.0.0.0');
  });

  it('name the accepted levels when given an unknown one', () => {
    const { problems } = parsed((into) => readLogLevel('loud', into));
    expect(problems[0]).toContain('debug, info, warn, error');
  });

  it('refuse an empty host rather than binding somewhere unstated', () => {
    const { problems } = parsed((into) => readHost('', into));
    expect(problems[0]).toContain('--host');
  });
});

describe('readTerminalCap', () => {
  it('defaults to a number a laptop survives', () => {
    expect(readTerminalCap(undefined, [])).toBe(DEFAULT_TERMINAL_CAP);
    expect(DEFAULT_TERMINAL_CAP).toBe(8);
  });

  it('reads a whole number of terminals', () => {
    expect(readTerminalCap('2', [])).toBe(2);
  });

  it('refuses a cap of zero rather than starting a server that can never run one', () => {
    const { problems } = parsed((into) => readTerminalCap('0', into));
    expect(problems[0]).toContain('at least 1');
  });

  it('refuses a cap that is not a whole number of terminals', () => {
    expect(parsed((into) => readTerminalCap('lots', into)).problems).toHaveLength(1);
    expect(parsed((into) => readTerminalCap('2.5', into)).problems).toHaveLength(1);
  });
});

describe('readDrainSeconds', () => {
  it('defaults to the number install.sh renders beside the unit timeout', () => {
    expect(readDrainSeconds(undefined, [])).toBe(DEFAULT_DRAIN_MS);
    expect(DEFAULT_DRAIN_MS).toBe(15_000);
  });

  it('is read in seconds, because the unit line it has to agree with is', () => {
    expect(readDrainSeconds('30', [])).toBe(30_000);
  });

  it('accepts no drain at all, which is the shutdown this replaced', () => {
    // Not refused the way a terminal cap of zero is. A cap of zero describes a
    // server that can never do its job; this describes one that waits for
    // nothing, and it still closes at a boundary whatever is already at one.
    expect(readDrainSeconds('0', [])).toBe(0);
  });

  it('refuses a budget that is not a whole number of seconds, or is negative', () => {
    for (const raw of ['-1', 'soon', '2.5']) {
      expect(parsed((into) => readDrainSeconds(raw, into)).problems).toHaveLength(1);
    }
  });
});

describe('readAnnounce', () => {
  it('is off until somebody says otherwise', () => {
    // A default of on would be a program that broadcasts its address on
    // whatever network it was installed next to. No default is right for both
    // the homelab and the laptop on a cafe wifi, so the operator says.
    expect(readAnnounce(undefined, [])).toBe(false);
  });

  it('takes the two words and nothing else', () => {
    expect(readAnnounce('true', [])).toBe(true);
    expect(readAnnounce('false', [])).toBe(false);
  });

  it('refuses a value it would have to guess at', () => {
    // Guessing wrong in one direction starts broadcasting on a network where
    // nobody asked for it.
    const { problems } = parsed((into) => readAnnounce('yes', into));
    expect(problems[0]).toContain('true or false');
  });
});

describe('readTimezone', () => {
  it('is unset until somebody says otherwise, which leaves a child inheriting', () => {
    // The honest default, and the one `binPath` takes for the same reason: a
    // deployment that has said nothing about a zone gets what the unit gave
    // it, rather than a zone this program picked on its behalf.
    expect(readTimezone(undefined, [])).toBeUndefined();
  });

  it('refuses a name no zone answers to, rather than handing a child a silent UTC', () => {
    // What the check buys. A child handed a `TZ` naming nothing does not
    // refuse; it sits in UTC, and the operator finds out when an agent tells
    // them the wrong day. This turns that into one sentence at startup.
    const { problems } = parsed((into) => readTimezone('Europe/Madird', into));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Europe/Madird');
  });

  it('accepts UTC, which the list of canonical names does not contain', () => {
    // Measured rather than assumed, and the reason this is not checked against
    // `Intl.supportedValuesOf('timeZone')`: on Node 24 that list holds neither
    // `UTC` nor any `US/*` name, so a membership test would refuse the single
    // most likely value an operator types.
    expect(Intl.supportedValuesOf('timeZone')).not.toContain('UTC');
    expect(readTimezone('UTC', [])).toBe('UTC');
  });

  it('accepts the aliases a machine accepts, spelled the way the operator wrote them', () => {
    // Every one of these is a real entry in the tz database a child looks the
    // word up in -- `date` reports PDT and IST for the first two inside
    // `node:24-bookworm-slim` -- so they are kept as typed. Rewriting
    // `Asia/Kolkata` to the `Asia/Calcutta` that ICU still canonicalizes it to
    // would put a name in a session that its operator did not choose.
    expect(readTimezone('US/Pacific', [])).toBe('US/Pacific');
    expect(readTimezone('Asia/Kolkata', [])).toBe('Asia/Kolkata');
    expect(readTimezone('Europe/Kyiv', [])).toBe('Europe/Kyiv');
  });

  it('corrects the capitalization, which is the spelling that would silently fail', () => {
    // The one input ICU accepts and a child does not. ICU matches a zone name
    // case-insensitively; the tz database is a directory of files, so glibc
    // finds nothing for `america/new_york` and falls back to UTC without a
    // word -- `date` prints `america +0000` inside `node:24-bookworm-slim`.
    // Normalized rather than refused, for the reason a path is normalized
    // rather than refused: it is the same zone, and ICU has just said how it
    // is spelled.
    expect(readTimezone('america/new_york', [])).toBe('America/New_York');
    expect(readTimezone('utc', [])).toBe('UTC');
  });
});

describe('readServerToken', () => {
  /**
   * Longer than the floor, and nothing a minter would produce, so a test that
   * finds this string found the configured token.
   */
  const TOKEN = 'a-token-the-deployment-already-held-0123';

  it('mints nothing when the deployment set none, which is every machine with a disk', () => {
    expect(readServerToken(undefined, [])).toBeUndefined();
  });

  it('carries the setting name with the value, so a refusal can name what to change', () => {
    // The module that refuses a disagreement lives in a package that does not
    // own this variable's name, and a refusal it could not name would send an
    // operator looking.
    expect(readServerToken(TOKEN, [])).toEqual({
      token: TOKEN,
      setting: 'AGENTPLEX_SERVER_TOKEN',
    });
  });

  it('refuses one short enough to guess rather than taking it as given', () => {
    // A minted token has 43 characters of CSPRNG behind it. A supplied one is
    // whatever somebody typed, and the failure is a server anybody on the
    // network can pair with.
    const { value, problems } = parsed((into) => readServerToken('letmein', into));
    expect(value).toBeUndefined();
    expect(problems[0]).toContain('--server-token');
  });
});

/**
 * The two paths that default from the account's home, and share the one rule
 * for when there is none to default from.
 */
describe('readDataPath', () => {
  it('defaults to the directory under the account home an install already owns', () => {
    // The same directory `install.sh` calls the state directory on the tier
    // that has a home: a machine that was never told where to put this gets
    // the place everything else about agentplex on it already is.
    expect(readDataPath(undefined, { HOME: '/home/dev' }, [])).toBe('/home/dev/.agentplex');
  });

  it('is what is set, not what the home would have given', () => {
    // The fleet tier's account has a home and its state lives somewhere else.
    expect(readDataPath('/srv/agentplex', { HOME: '/var/lib/agentplex' }, [])).toBe(
      '/srv/agentplex',
    );
  });

  it('refuses a relative path, which would be a different directory per working directory', () => {
    const { problems } = parsed((into) => readDataPath('agentplex', { HOME: '/home/dev' }, into));
    expect(problems[0]).toContain('absolute path');
  });

  it('normalizes the path it was given, so one directory has one name', () => {
    expect(readDataPath('/var/lib/other/../agentplex/', {}, [])).toBe('/var/lib/agentplex');
  });

  it('refuses to guess when there is no home to default from', () => {
    // The one thing it must not do is pick something. A server whose state
    // went to a directory nobody named forgets it the first time that
    // directory is not there, and nothing anywhere says why.
    const { value, problems } = parsed((into) => readDataPath(undefined, {}, into));
    expect(value).toBeUndefined();
    expect(problems[0]).toContain('AGENTPLEX_DATA_PATH');
    expect(problems[0]).toContain('HOME');
  });

  it('refuses a home that is not absolute rather than resolving it against a cwd', () => {
    const { problems } = parsed((into) => readDataPath(undefined, { HOME: 'dev' }, into));
    expect(problems[0]).toContain('HOME');
    expect(problems[0]).toContain('"dev"');
  });

  it('treats a blank home as no home, which is what an env file line with nothing after it is', () => {
    const { problems } = parsed((into) => readDataPath(undefined, { HOME: '  ' }, into));
    expect(problems).toHaveLength(1);
  });
});

describe('readIdentityPath', () => {
  it('defaults to server.json under the same directory as the data root', () => {
    // Where `agentplex setup` mints it on the per-user tier, so a machine set
    // up the ordinary way and never told the path starts the server that
    // setup paired rather than refusing to start one.
    expect(readIdentityPath(undefined, { HOME: '/home/dev' }, [])).toBe(
      '/home/dev/.agentplex/server.json',
    );
  });

  it('takes what is set over what the home would have given', () => {
    expect(readIdentityPath('/srv/id.json', { HOME: '/home/dev' }, [])).toBe('/srv/id.json');
  });

  it('refuses a relative path, which would be a different file per working directory', () => {
    // The failure this prevents is silent: a server started from elsewhere
    // mints a second identity, and the pairing the user completed stops
    // working with nothing anywhere saying why.
    const { problems } = parsed((into) => readIdentityPath('server.json', {}, into));
    expect(problems[0]).toContain('absolute path');
  });

  it('normalizes the path it was given', () => {
    expect(readIdentityPath('/srv/../srv/id.json', {}, [])).toBe('/srv/id.json');
  });

  it('refuses to guess when there is no home to default from, and names its own setting', () => {
    const { value, problems } = parsed((into) => readIdentityPath(undefined, {}, into));
    expect(value).toBeUndefined();
    expect(problems[0]).toContain('AGENTPLEX_SERVER_IDENTITY_FILE');
    expect(problems[0]).toContain('--server-identity-file');
  });

  it('refuses a home that is not absolute', () => {
    const { problems } = parsed((into) => readIdentityPath(undefined, { HOME: 'dev' }, into));
    expect(problems[0]).toContain('HOME');
  });
});

describe('readLocalServer', () => {
  it('names none by default: a hub does not go looking for a server beside it', () => {
    expect(readLocalServer(undefined, undefined, [])).toBeNull();
  });

  it('is an entry once the identity file is named, on the server default port', () => {
    expect(readLocalServer('/var/lib/agentplex/server.json', undefined, [])).toEqual({
      identityPath: '/var/lib/agentplex/server.json',
      port: 8081,
    });
  });

  it('reads the port beside it', () => {
    expect(readLocalServer('/srv/server.json', '9091', [])).toEqual({
      identityPath: '/srv/server.json',
      port: 9091,
    });
  });

  it('refuses a port with no identity file, which names nothing to pair', () => {
    const { value, problems } = parsed((into) => readLocalServer(undefined, '9091', into));
    expect(value).toBeNull();
    expect(problems[0]).toContain('--local-server-identity-file');
  });

  it('refuses a relative identity file', () => {
    const { value, problems } = parsed((into) => readLocalServer('server.json', undefined, into));
    expect(value).toBeNull();
    expect(problems[0]).toContain('absolute path');
  });
});
