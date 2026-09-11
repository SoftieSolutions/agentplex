import { isAbsolute, join, resolve } from 'node:path';
import { providerSchema } from '@agentplex/protocol';
import { z } from 'zod';

/**
 * A setup plan: the machine somebody meant, as a file.
 *
 * The wizard is not the setup. It is one front end that produces one of these,
 * and provisioning consumes it — so `agentplex setup --plan <file>` replays
 * unattended exactly what an interactive run would have done, and an EC2
 * instance can be handed the artifact in user-data or have it baked into an
 * image. That is the whole reason the wizard produces a replayable value
 * instead of merely mutating a machine.
 *
 * It arrives from disk, so it is a claim. Everything below is a parser that can
 * say no, and nothing downstream re-checks a field by hand.
 *
 * Two rules shape the schema:
 *
 * - **Strict.** A plan file is hand-edited — by an operator writing user-data,
 *   by whoever copied one image's plan onto another machine. `storePath` for
 *   `storePaths` would otherwise parse as a server that watches nothing, and
 *   the mistake would surface as a hub reporting no stores on a machine full of
 *   them. An unknown key is refused where it is cheap to say so.
 * - **Versioned.** The first thing parsed is what shape the file claims to be.
 *   A build that met a later plan and read the fields it happened to recognise
 *   would provision a machine the plan does not describe, and say nothing.
 *
 * What a plan deliberately does **not** carry is as decided as what it does.
 * There is no client token and no database file in here. The client token is
 * the one credential between the internet and every session on every paired
 * machine, and a plan is a file that lives in user-data, in an image, and in
 * whatever bucket somebody copied it to; the database file is a location a
 * deployment picks where it runs the service. Both already arrive as
 * configuration with no default, which is where a secret and a storage location
 * belong. The pairing token is the deliberate exception and is discussed on the
 * field itself.
 */

/**
 * The plan format this build reads and writes.
 *
 * A number rather than a range: a plan is an artifact that outlives the build
 * that wrote it, and "I do not know this shape" is an answer an operator can act
 * on, where a best-effort read of an unknown shape is not.
 */
export const SETUP_PLAN_VERSION = 1;

/**
 * A pre-minted pairing token has to be a token.
 *
 * The same floor the hub's client token gets, for a weaker but real reason: this
 * secret is what one hub presents to claim a server, so a guessable one is a
 * machine anybody on the network can attach to. What it refuses is the word
 * somebody typed into the plan file to get past the field; anything a CSPRNG
 * produced passes without thinking about it.
 */
const MIN_PAIRING_TOKEN_LENGTH = 32;

/**
 * Where npm and every other POSIX prefix installer puts the programs it
 * installs. Named here because it is the one piece of knowledge that turns "the
 * prefix agentplex owns" into "a directory to resolve `claude` in".
 */
const PREFIX_BIN_DIRECTORY = 'bin';

/**
 * A directory or file the plan names, absolute and normalised to one spelling.
 *
 * Relative is refused for the reason `ServerConfig` refuses it, one step
 * earlier: a relative path in a plan replayed from cloud-init means whatever
 * directory cloud-init left the process in, so the same artifact would describe
 * a different machine on every boot. `resolve` on an absolute path never
 * consults the working directory; it collapses `..` and a trailing separator so
 * that one directory has one name.
 */
const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), { error: 'must be an absolute path' })
  .transform((value) => resolve(value));

/**
 * An ordered list of directories, each named once.
 *
 * Order is search order and is kept. A directory spelled two ways is one
 * directory: a plan that named the same store twice must not produce a server
 * that watches it twice, which is the same reconciling rule the apply path is
 * held to, applied to the file itself.
 */
const directoriesSchema = z
  .array(absolutePathSchema)
  .transform((paths) => paths.filter((path, index) => paths.indexOf(path) === index));

/**
 * A port as JSON has it: a number.
 *
 * Deliberately not coerced. `"8081"` is a plan written by something that
 * stringified its settings, and a parser that accepts it is one that will accept
 * the next value that arrives as a string too — including the ones where the
 * difference matters.
 */
const portSchema = z.int().min(1).max(65535);

/**
 * One provider to have on this machine, and which version of it.
 *
 * The name is parsed here, unlike in a provisioning operation's request, and the
 * difference is the boundary: a plan is read whole before anything runs, so a
 * misspelled provider costs nothing where it would otherwise be discovered
 * between two installs. What stays the registry's answer at apply time is the
 * other refusal — a provider agentplex knows and this build has no adapter for —
 * which is a fact about the binary rather than about the file.
 */
const plannedProviderSchema = z.strictObject({
  provider: providerSchema,
  /**
   * A pinned version, or `null` for whatever the provider calls current.
   *
   * A pin is what makes replaying an artifact in a month produce the machine it
   * described. `null` has to stay expressible, because the first plan written
   * for a new machine has no version to name yet.
   */
  version: z.string().min(1).nullable(),
});
export type PlannedProvider = z.infer<typeof plannedProviderSchema>;

const plannedProvidersSchema = z.array(plannedProviderSchema).superRefine((planned, context) => {
  // Two entries for one provider is the failure this whole path exists to
  // prevent, at the earliest point anything can see it: it would install the
  // provider twice, and the second pin would silently win.
  const seen = new Set<string>();
  for (const { provider } of planned) {
    if (seen.has(provider)) {
      context.addIssue({ code: 'custom', message: `${provider} is planned twice` });
    }
    seen.add(provider);
  }
});

const plannedHubSchema = z.strictObject({ port: portSchema });
export type PlannedHub = z.infer<typeof plannedHubSchema>;

const plannedServerSchema = z.strictObject({
  port: portSchema,
  /** The store roots this machine mounts. Empty is legal, as it is in the config. */
  storePaths: directoriesSchema,
  /**
   * Directories to resolve a provider in, ahead of whatever PATH the service
   * inherits: the operator's homebrew prefix, a version manager's shim
   * directory, `~/.local/bin`.
   *
   * These are the directories setup *adopts* from, so they come first — the
   * binary an operator has already authenticated is the binary that should run.
   */
  binPath: directoriesSchema,
  /** Where this server keeps its `serverId` and its pairing token. */
  identityPath: absolutePathSchema,
  /**
   * The prefix agentplex owns and installs into when it finds nothing to adopt.
   *
   * An absolute path in the file rather than `~/.agentplex` expanded at replay
   * time: a plan baked into an image is replayed on a machine whose `$HOME` is
   * not the one the plan was written on, and a prefix that moves with the user
   * is a prefix the recorded `binPath` no longer names.
   */
  installPrefix: absolutePathSchema,
  /**
   * A pairing token minted before the machine existed, or `null` to mint one on
   * the machine.
   *
   * This is the one secret a plan carries, and it is the tier the artifact
   * exists for: an EC2 instance whose token was decided in advance is pairable
   * the moment it boots, where one that mints its own is a machine somebody has
   * to SSH into to read a file. It is narrower than it looks — the token
   * authorises one hub to dial one server, it is written to that server's own
   * identity file either way, and it is never printed by anything here.
   *
   * `null` and absent mean the same thing and are both accepted: a wizard
   * emitting JSON writes the field, and a person writing user-data omits it.
   */
  pairingToken: z
    .string()
    .min(MIN_PAIRING_TOKEN_LENGTH)
    .nullish()
    .transform((token) => token ?? null),
  providers: plannedProvidersSchema,
});
export type PlannedServer = z.infer<typeof plannedServerSchema>;

const versionSchema = z.literal(SETUP_PLAN_VERSION);

/**
 * A plan is the halves its role has, and no others.
 *
 * The same union `Config` is, for the same reason: in `--role=hub` there is no
 * server to give store paths to, and the type should be what makes that true.
 * A role naming a half the file does not carry is refused rather than defaulted
 * — half of what somebody meant, provisioned quietly, is worse than a refusal
 * naming the block they deleted.
 */
/**
 * The three things a machine can be, which is what `--role` means to setup and
 * to the installer: which files setup writes, and which units the installer
 * will run. Neither daemon takes a role; which daemon runs is which program
 * was started, and a machine that is `both` starts one of each.
 */
export const ROLES = ['hub', 'server', 'both'] as const;
export type Role = (typeof ROLES)[number];

const setupPlanSchema = z.discriminatedUnion('role', [
  z.strictObject({ version: versionSchema, role: z.literal('hub'), hub: plannedHubSchema }),
  z.strictObject({
    version: versionSchema,
    role: z.literal('server'),
    server: plannedServerSchema,
  }),
  z.strictObject({
    version: versionSchema,
    role: z.literal('both'),
    hub: plannedHubSchema,
    server: plannedServerSchema,
  }),
]);

export type SetupPlan = z.infer<typeof setupPlanSchema>;

export type SetupPlanParse =
  | { readonly ok: true; readonly plan: SetupPlan }
  /** Every problem, not the first: a plan replayed unattended fails whole. */
  | { readonly ok: false; readonly problems: readonly string[] };

/** The parser that can say no. Every path from a file into a `SetupPlan` is this one. */
export function parseSetupPlan(contents: string): SetupPlanParse {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (error) {
    return { ok: false, problems: [`the plan is not JSON: ${String(error)}`] };
  }

  const parsed = setupPlanSchema.safeParse(json);
  if (parsed.success) return { ok: true, plan: parsed.data };

  return {
    ok: false,
    problems: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}

/**
 * A plan as a file, in the one spelling this program writes.
 *
 * Beside the parser deliberately: these two are a pair, and the property that
 * matters about the wizard's last screen is that what it saves is a file this
 * parser reads back as the same plan. A serializer somewhere else is a second
 * opinion about the format, and the one that would rot is the one that is not
 * next to the schema.
 *
 * Indented with a trailing newline, like the store file, because this is a file
 * people open and hand-edit — that is the whole point of an artifact that gets
 * baked into an image.
 */
export function serializeSetupPlan(plan: SetupPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/**
 * The directories a run of this plan resolves a program in, in search order.
 *
 * A pure function of the plan, which is what makes a replay deterministic: the
 * same file produces the same `PATH` on the first boot and on the tenth, so a
 * second run finds what the first one installed and adopts it instead of
 * installing it again. It is also what a `ServerConfig` should record — the
 * directories setup probed, which is what `binPath` means.
 *
 * The plan's own directories come first and the owned prefix last. Prepending
 * the prefix would let a copy agentplex installed shadow the binary the operator
 * authenticated, which is the failure adoption exists to prevent; appending it
 * means the prefix wins only where nothing else answers, which is exactly when
 * setup put something there.
 */
export function setupBinPath(plan: SetupPlan): readonly string[] {
  if (!('server' in plan)) return [];

  const directories = [
    ...plan.server.binPath,
    join(plan.server.installPrefix, PREFIX_BIN_DIRECTORY),
  ];
  return directories.filter((path, index) => directories.indexOf(path) === index);
}
