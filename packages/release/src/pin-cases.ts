/**
 * The one table of pins, which both programs that read a pin are tested
 * against.
 *
 * There are two readers of `<component>@<pin>` and they cannot share code:
 * `install.sh` runs before there is a Node on the machine, so its grammar and
 * its series resolver are bash, and `agentplex update` reads the same words in
 * TypeScript through `pin.ts`. What holds the two together is this table. The
 * release package's suite runs every row against `readPin` and
 * `newestInSeries`, and `scripts/install.sh.integration.test.ts` runs the same
 * rows against `install.sh --dry-run` -- so a case added here is a case added
 * to both, and a word the two classify differently is a red test in one of
 * them.
 *
 * Hand-written cases rather than a fixture, which is why this is a module
 * behind the `testing` entry and not a file under `fixtures/`: a fixture is
 * captured real output, and nothing captured a pin.
 */

/** What a word after `@` is: a tag, a series of tags, or not a pin at all. */
export type PinKind = 'exact' | 'series' | 'refused';

export interface PinGrammarCase {
  readonly word: string;
  readonly kind: PinKind;
}

/**
 * Every word worth writing down, with what it is.
 *
 * The three drift words at the end are the reason the table exists. `install.sh`
 * used to read a prerelease tail as any run of `[0-9A-Za-z.-]`, which accepts a
 * leading zero in a numeric identifier and an empty identifier, and semver.org
 * -- and so the manifest schema -- refuses all three. A pin the schema can never
 * list is a pin that could only fail later, as "not published".
 */
export const PIN_GRAMMAR_CASES: readonly PinGrammarCase[] = [
  { word: '1.0.0', kind: 'exact' },
  { word: '0.0.1', kind: 'exact' },
  { word: '1.2.3-rc.1', kind: 'exact' },
  { word: '10.20.30', kind: 'exact' },
  { word: '1.2.3+build.5', kind: 'exact' },
  { word: '1.3.8-rc1', kind: 'exact' },
  { word: '1', kind: 'series' },
  { word: '1.3', kind: 'series' },
  { word: '0', kind: 'series' },
  { word: '0.0', kind: 'series' },
  { word: '10.20', kind: 'series' },
  { word: '', kind: 'refused' },
  { word: 'latest', kind: 'refused' },
  { word: 'v1.2.3', kind: 'refused' },
  { word: 'v1.3', kind: 'refused' },
  { word: '1.2.3.4', kind: 'refused' },
  { word: '01.2.3', kind: 'refused' },
  { word: '01.3', kind: 'refused' },
  { word: '1.3.', kind: 'refused' },
  { word: '1.3.x', kind: 'refused' },
  { word: '^1.3.0', kind: 'refused' },
  { word: '1.2.3-01', kind: 'refused' },
  { word: '1.2.3-a..b', kind: 'refused' },
  { word: '1.2.3-.', kind: 'refused' },
];

export interface SeriesResolutionCase {
  readonly name: string;
  /**
   * Every release the component has published, in the order it published them.
   * The order is stated because the manifest writer is what turns it into a
   * file, and a fixture is a file some run of releases could leave behind.
   */
  readonly releases: readonly string[];
  readonly series: string;
  /** The release the series resolves to, or `null` when it holds none. */
  readonly expect: string | null;
}

export const SERIES_RESOLUTION_CASES: readonly SeriesResolutionCase[] = [
  {
    name: 'takes the newest release in the series, and not the newest overall',
    releases: ['1.1.4', '1.2.9'],
    series: '1.1',
    expect: '1.1.4',
  },
  {
    name: 'compares the patch as a number and not as text',
    releases: ['1.3.2', '1.3.9', '1.3.10'],
    series: '1.3',
    expect: '1.3.10',
  },
  {
    name: 'takes the newest release under a major',
    releases: ['1.9.1', '2.0.0'],
    series: '1',
    expect: '1.9.1',
  },
  {
    name: 'never resolves a series to a prerelease',
    releases: ['1.3.7', '1.3.8-rc1'],
    series: '1.3',
    expect: '1.3.7',
  },
  {
    name: 'does not take a series to be a prefix of a longer number',
    releases: ['1.30.0'],
    series: '1.3',
    expect: null,
  },
  {
    name: 'finds nothing when the series holds no release at all',
    releases: ['1.2.0'],
    series: '7',
    expect: null,
  },
];
