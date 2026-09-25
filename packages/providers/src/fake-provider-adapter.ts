import {
  activitySchema,
  sessionIdSchema,
  sessionUsageSchema,
  type Provider,
  type ProviderReadiness,
  type SessionStatus,
  type StoreDescriptor,
} from '@agentplex/protocol';
import { z } from 'zod';
import { createFakeProviderFiles } from './fake-provider-files.js';
import type {
  AuthProbe,
  DiscoveredSession,
  DiscoveryProblem,
  InstallPlan,
  InstallRequest,
  Launch,
  LoginRequest,
  ProviderAdapter,
  ProviderDiscovery,
  ProviderProvisioning,
  ResumeRequest,
  SpawnRequest,
  StatusObservation,
  TranscriptRead,
  TranscriptRequest,
  VersionProbe,
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
  /**
   * When this made-up session was first written. Absent means at its last
   * write, which keeps a fixture that states only `updatedAt` saying one date
   * rather than inventing a second.
   */
  createdAt: z.int().nonnegative().optional(),
  updatedAt: z.int().nonnegative(),
  /**
   * Whether this made-up provider verified a live process of its own. Absent
   * means it did not, which is what a provider that keeps no registry looks
   * like — and it keeps these tests exercising the caller's own liveness path.
   */
  running: z.boolean().optional(),
  /**
   * The pid of that verified process. A fixture that names one says
   * `running: true` beside it, because a real adapter reports a pid only for a
   * process it verified; nothing here checks the pair, and a fixture that set
   * one without the other would be describing no provider that exists.
   */
  pid: z.int().positive().nullish(),
  /** This made-up provider records neither, and `null` is what that looks like. */
  cwd: z.string().min(1).nullish(),
  title: z.string().min(1).nullish(),
  /**
   * What this made-up provider says the session cost, when it says anything.
   * Absent is the default on purpose: a provider that counts no tokens is a
   * case the seam has to carry, and it is the one this fake defaults to.
   */
  usage: sessionUsageSchema.nullish(),
  /**
   * Which model this made-up provider says answered, when it says anything.
   * Absent defaults to no model for the same reason `usage` does: a provider
   * that never names one is a case the seam has to carry, and a caller that
   * wants a model on the wire has to put one in the transcript to get it.
   */
  model: z.string().min(1).nullish(),
  /**
   * What this made-up provider says the session is doing, when it says
   * anything. The protocol's own schema rather than a shape of this fake's:
   * an adapter is the last place an activity is parsed, and a fake that
   * invented its own vocabulary would be exercising a seam nothing crosses.
   */
  activity: activitySchema.nullish(),
  /**
   * Everything this made-up provider says the session has done, oldest first,
   * when it says anything. Absent is a session whose record holds nothing --
   * the ordinary case, and the one a caller has to handle.
   *
   * The protocol's own schema again rather than a shape of this fake's: an
   * adapter is the last place an activity is parsed, and a fake with its own
   * vocabulary would exercise a seam nothing crosses.
   */
  activities: z.array(activitySchema).optional(),
});

export interface FakeProviderAdapterOptions {
  readonly provider?: Provider;
  readonly files?: ProviderFiles;
  /** Makes `discover` throw, to prove a broken adapter costs only its provider. */
  readonly throwsOnDiscover?: string;
  /**
   * Makes `transcript` throw, to prove that a server asking a third party's
   * adapter for one answers a refusal rather than an unhandled rejection.
   */
  readonly throwsOnTranscript?: string;
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

    // A made-up provider keeps its state where a real one does not, and
    // deliberately not in a dotfile: what setup has to be able to offer is
    // whatever an adapter says, never a convention it could have assumed.
    defaultStoreDirectory: `state/${provider}`,

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

    async transcript(request: TranscriptRequest): Promise<TranscriptRead> {
      if (options.throwsOnTranscript !== undefined) throw new Error(options.throwsOnTranscript);
      return await readSessionTranscript(
        `${sessionsDirectory(request.store, provider)}/${request.session.sessionId}.json`,
        request.limit,
        files,
      );
    },

    provisioning: fakeProvisioning(provider),

    // A made-up provider with no hook, which is the case the seam has to carry
    // and the one a caller must handle without asking which provider it has.
    permissionHook: null,

    get observations() {
      return observations;
    },
  };
}

/**
 * What a startup preflight reports for a provider that is installed, answers
 * its version probe and says it is logged in.
 *
 * A helper rather than a literal in every test, because every test that starts
 * a session needs one and none of them is about it: what they are about is what
 * happens when a session is started on a machine where this holds. The unhappy
 * readings are written out where they are the subject.
 */
export function readyProvider(provider: Provider = 'claude'): ProviderReadiness {
  return {
    provider,
    state: 'ready',
    version: '9.9.9',
    directory: '/home/robert/.agentplex/bin',
    problem: null,
  };
}

/**
 * What a preflight reports for a provider no directory on the machine holds.
 *
 * The reading that costs a start, and the one AGX-68 found could never be
 * reported at spawn time on a pty.
 */
export function missingProvider(provider: Provider = 'claude'): ProviderReadiness {
  return {
    provider,
    state: 'missing',
    version: null,
    directory: null,
    problem: `no directory this server searches holds ${provider}`,
  };
}

/**
 * What a preflight reports for a provider that is installed and logged out.
 *
 * Beside `missingProvider` because it is the other refusal, and a different
 * thing for a person to do: the program is there, its version answered, and
 * what is wanted is a login on that machine rather than an install. A caller
 * that only ever built the missing reading would be testing one half of the
 * refusal and imagining the other.
 */
export function unauthenticatedProvider(provider: Provider = 'claude'): ProviderReadiness {
  return {
    provider,
    state: 'unauthenticated',
    version: '9.9.9',
    directory: '/home/robert/.agentplex/bin',
    problem: `${provider} is installed and logged out; run its login on that machine`,
  };
}

/**
 * What a preflight reports for a provider it found and could not question.
 *
 * The reading that is deliberately not a refusal: the binary resolved, so a
 * start reaches a program, and what could not be read is a version. A helper
 * for the same reason the other two are -- every surface that offers a
 * provider has to offer this one with its problem beside it, and a
 * hand-written copy in each of them would drift.
 */
export function unknownProvider(provider: Provider = 'claude'): ProviderReadiness {
  return {
    provider,
    state: 'unknown',
    version: null,
    directory: '/home/robert/.agentplex/bin',
    problem: `${provider} could not report its version: it exited 1`,
  };
}

/**
 * Provisioning for a provider that does not exist, installed by a package
 * manager that does not exist either.
 *
 * Deliberately nothing like Claude Code's. What the seam has to keep expressible
 * is a provider whose installer is not npm, whose version flag is not
 * `--version`, and which answers "am I logged in" with a different subcommand
 * and a bare exit code rather than JSON — and the way to check that is an
 * implementation that shares none of those answers with the only real one.
 */
function fakeProvisioning(provider: Provider): ProviderProvisioning {
  return {
    install(request: InstallRequest): InstallPlan {
      if (!request.prefix.startsWith('/')) {
        return { ok: false, problem: 'an install prefix must be an absolute path' };
      }
      return {
        ok: true,
        plan: {
          argv: { file: 'fakepkg', args: ['add', '--into', request.prefix, provider] },
          timeoutMs: 30_000,
          read: (completed) =>
            completed.exitCode === 0
              ? { ok: true, result: { package: provider, version: completed.stdout.trim() } }
              : { ok: false, problem: `fakepkg exited ${completed.exitCode}` },
        },
      };
    },

    version(): VersionProbe {
      return {
        argv: { file: provider, args: ['version'] },
        timeoutMs: 5_000,
        read: (completed) =>
          completed.exitCode === 0
            ? { ok: true, result: completed.stdout.trim() }
            : { ok: false, problem: `${provider} exited ${completed.exitCode}` },
      };
    },

    authState(): AuthProbe {
      return {
        argv: { file: provider, args: ['whoami'] },
        timeoutMs: 5_000,
        read: (completed) =>
          completed.exitCode === 0
            ? { ok: true, result: 'authenticated' }
            : { ok: true, result: 'unauthenticated' },
      };
    },

    login(request: LoginRequest): Launch {
      return {
        ok: true,
        plan: {
          command: provider,
          args: ['login'],
          cwd: request.cwd,
          env: {},
          scrubEnvPrefixes: [],
        },
      };
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

/**
 * One made-up session's record, read as the activities it holds.
 *
 * `readFile` and not `readFileTail`, and the exception is the point rather than
 * an oversight. The bounded read exists because the real providers append JSONL
 * forever; this provider writes one small JSON object per session, and there is
 * no tail of a JSON object that parses. What the seam requires is that an
 * adapter bounds its read, not that every adapter bounds it the same way, and
 * an object small enough to be read whole is bounded by being one object.
 */
async function readSessionTranscript(
  path: string,
  limit: number,
  files: ProviderFiles,
): Promise<TranscriptRead> {
  const read = await files.readFile(path);
  if (read.kind === 'missing') {
    return { ok: false, problem: 'this store holds no transcript for that session' };
  }
  if (read.kind === 'failed') {
    return { ok: false, problem: `cannot read transcript: ${read.reason}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(read.contents);
  } catch (error) {
    return { ok: false, problem: `transcript is not JSON: ${String(error)}` };
  }

  const parsed = fakeTranscriptSchema.safeParse(json);
  if (!parsed.success) return { ok: false, problem: 'transcript is not a transcript' };

  const all = parsed.data.activities ?? [];
  return {
    ok: true,
    // Spelled out rather than `slice(-limit)`, which answers with the whole
    // array for a limit of zero: a caller that asked for none must get none.
    transcript: {
      activities: limit <= 0 ? [] : all.slice(-limit),
      olderExist: all.length > limit,
    },
  };
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
      createdAt: parsed.data.createdAt ?? parsed.data.updatedAt,
      updatedAt: parsed.data.updatedAt,
      running: parsed.data.running ?? false,
      pid: parsed.data.pid ?? null,
      cwd: parsed.data.cwd ?? null,
      title: parsed.data.title ?? null,
      usage: parsed.data.usage ?? null,
      model: parsed.data.model ?? null,
      activity: parsed.data.activity ?? null,
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
