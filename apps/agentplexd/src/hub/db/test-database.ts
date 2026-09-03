import process from 'node:process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Where an integration suite gets a Postgres.
 *
 * Two paths, in this order. `AGENTPLEX_TEST_DATABASE_URL` wins, because the
 * container path — `pnpm docker:test` — sets it, has no Docker daemon of its
 * own to talk to, and is the primary path for this project. Failing that, a
 * throwaway container is started through testcontainers, so the same suites run
 * on a laptop instead of skipping themselves there forever.
 *
 * When neither works the caller gets `null` and a line on stderr saying so. A
 * suite that cannot reach a database skips loudly; it never passes quietly.
 *
 * This module is test support and never ships: `tsconfig.build.json` excludes
 * `test-*.ts` along with `*.test.ts`.
 */
export interface TestDatabase {
  readonly url: string;
  /** Which path supplied it, so a slow or skipped run says why. */
  readonly source: 'environment' | 'testcontainers';
  stop(): Promise<void>;
}

/** The image the compose file uses, so both paths test against one server version. */
const POSTGRES_IMAGE = 'postgres:17-bookworm';

export async function openTestDatabase(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<TestDatabase | null> {
  const configured = env['AGENTPLEX_TEST_DATABASE_URL']?.trim();
  if (configured !== undefined && configured.length > 0) {
    // Not ours to stop: something outside this process started it.
    return { url: configured, source: 'environment', stop: async () => {} };
  }

  try {
    const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    return {
      url: container.getConnectionUri(),
      source: 'testcontainers',
      stop: async () => void (await container.stop()),
    };
  } catch (error) {
    console.warn(
      'SKIPPING the database integration suites: no AGENTPLEX_TEST_DATABASE_URL, and ' +
        `testcontainers could not start ${POSTGRES_IMAGE} (${String(error)}). ` +
        'Run `pnpm docker:test`, or start a Docker daemon, before believing these green.',
    );
    return null;
  }
}
