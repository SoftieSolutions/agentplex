import {
  sessionIdSchema,
  type Provider,
  type SessionStatus,
  type StoreDescriptor,
} from '@agentplex/protocol';
import { z } from 'zod';
import { createFakeProviderFiles } from './fake-provider-files.js';
import type {
  DiscoveredSession,
  DiscoveryProblem,
  Launch,
  ProviderAdapter,
  ProviderDiscovery,
  ResumeRequest,
  SpawnRequest,
  StatusObservation,
} from './provider-adapter.js';
import type { ProviderFiles } from './provider-files.js';

/**
 * An adapter for a provider that does not exist, with the simplest layout a
 * layout can be: one JSON file per session under `<store>/<provider>/sessions`.
 *
 * It is here to exercise the seam, not to preview the Claude adapter. Using a
 * made-up layout is deliberate: a test that passes against a fixture of real
 * Claude Code output would be testing that adapter, and this ticket ships no
 * adapter. What these tests do assert is that a provider with its own layout,
 * its own transcript vocabulary and its own timing rules fits behind the
 * interface without the caller learning any of it.
 */
export const FAKE_SESSIONS_DIRECTORY = '/sessions';

/** Long enough that a test can be either side of it without waiting. */
const FAKE_WORKING_WINDOW_MS = 60_000;

const fakeTranscriptSchema = z.object({
  signal: z.enum(['awaiting-permission', 'awaiting-input', 'progressing', 'quiet', 'unknown']),
  updatedAt: z.int().nonnegative(),
  /**
   * Whether this made-up provider verified a live process of its own. Absent
   * means it did not, which is what a provider that keeps no registry looks
   * like — and it keeps these tests exercising the caller's own liveness path.
   */
  running: z.boolean().optional(),
  /** This made-up provider records neither, and `null` is what that looks like. */
  cwd: z.string().min(1).nullish(),
  title: z.string().min(1).nullish(),
});

export interface FakeProviderAdapterOptions {
  readonly provider?: Provider;
  readonly files?: ProviderFiles;
  /** Makes `discover` throw, to prove a broken adapter costs only its provider. */
  readonly throwsOnDiscover?: string;
  readonly status?: (observation: StatusObservation) => SessionStatus;
}

export interface FakeProviderAdapter extends ProviderAdapter {
  /** Every observation `status` was asked about, in order. */
  readonly observations: readonly StatusObservation[];
}

export function createFakeProviderAdapter(
  options: FakeProviderAdapterOptions = {},
): FakeProviderAdapter {
  const provider = options.provider ?? 'claude';
  const files = options.files ?? createFakeProviderFiles();
  const observations: StatusObservation[] = [];

  return {
    provider,

    async discover(store: StoreDescriptor): Promise<ProviderDiscovery> {
      if (options.throwsOnDiscover !== undefined) throw new Error(options.throwsOnDiscover);
      return readSessions(sessionsDirectory(store, provider), files);
    },

    spawn(request: SpawnRequest): Launch {
      return {
        ok: true,
        plan: {
          command: provider,
          args: request.prompt === null ? [] : [request.prompt],
          cwd: request.cwd,
          env: {},
          scrubEnvPrefixes: [],
        },
      };
    },

    resume(request: ResumeRequest): Launch {
      // A made-up provider that records no cwd is exactly the case the seam
      // has to keep expressible: discovery reports `null` and the only honest
      // answer is a refusal.
      if (request.cwd === null) {
        return { ok: false, problem: 'this session has no working directory to run in' };
      }
      return {
        ok: true,
        plan: {
          command: provider,
          args: ['--resume', request.session.sessionId],
          cwd: request.cwd,
          env: {},
          scrubEnvPrefixes: [],
        },
      };
    },

    status(observation: StatusObservation): SessionStatus {
      observations.push(observation);
      return options.status?.(observation) ?? fakeStatus(observation);
    },

    get observations() {
      return observations;
    },
  };
}

function sessionsDirectory(store: StoreDescriptor, provider: Provider): string {
  return `${store.path}/${provider}${FAKE_SESSIONS_DIRECTORY}`;
}

async function readSessions(directory: string, files: ProviderFiles): Promise<ProviderDiscovery> {
  const listing = await files.listDirectory(directory);
  // Absent is not broken: this provider has simply never written into this store.
  if (listing.kind === 'missing') return { sessions: [], problems: [] };
  if (listing.kind === 'failed') {
    return { sessions: [], problems: [{ subject: directory, problem: listing.reason }] };
  }

  const sessions: DiscoveredSession[] = [];
  const problems: DiscoveryProblem[] = [];

  for (const entry of listing.entries) {
    if (entry.kind !== 'file') continue;
    const path = `${directory}/${entry.name}`;

    const read = await files.readFile(path);
    if (read.kind !== 'read') {
      problems.push({ subject: path, problem: `cannot read transcript: ${describe(read)}` });
      continue;
    }

    const session = parseTranscript(entry.name, read.contents);
    if (session.ok) sessions.push(session.session);
    else problems.push({ subject: path, problem: session.problem });
  }

  return { sessions, problems };
}

function parseTranscript(name: string, contents: string) {
  const sessionId = sessionIdSchema.safeParse(name.replace(/\.json$/, ''));
  if (!sessionId.success) return { ok: false as const, problem: 'not a session id' };

  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (error) {
    return { ok: false as const, problem: `transcript is not JSON: ${String(error)}` };
  }

  const parsed = fakeTranscriptSchema.safeParse(json);
  if (!parsed.success) return { ok: false as const, problem: 'transcript is not a transcript' };

  return {
    ok: true as const,
    session: {
      sessionId: sessionId.data,
      signal: parsed.data.signal,
      updatedAt: parsed.data.updatedAt,
      running: parsed.data.running ?? false,
      cwd: parsed.data.cwd ?? null,
      title: parsed.data.title ?? null,
    },
  };
}

function describe(read: { kind: 'missing' } | { kind: 'failed'; reason: string }): string {
  return read.kind === 'missing' ? 'it is gone' : read.reason;
}

/**
 * One provider's timing rule, kept inside the adapter where it belongs: a live
 * process that has not written for a while is still working as far as this
 * provider is concerned, and a dead one that was mid-work is not.
 */
function fakeStatus({ signal, updatedAt, running, now }: StatusObservation): SessionStatus {
  if (signal === 'awaiting-permission' || signal === 'awaiting-input') return signal;
  if (running) return 'working';
  if (signal === 'unknown') return 'unknown';
  if (signal === 'progressing' && now - updatedAt < FAKE_WORKING_WINDOW_MS) return 'working';
  return 'idle';
}
