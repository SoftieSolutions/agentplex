import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAUDE_COMMAND, CLAUDE_SCRUB_PREFIXES } from './claude-launch.js';

/**
 * Captures what Claude Code hands a `PermissionRequest` hook on its stdin, by
 * running a real `claude` against a real hook and keeping the bytes.
 *
 * That payload is the whole basis of the approvals feature, and every field of
 * it is a claim about a program this repository does not own. A fixture typed
 * out from documentation would prove that the parser handles the shape its
 * author imagined, and the two things that shape actually got wrong when
 * somebody looked are exactly the kind a document does not settle: there is no
 * `tool_use_id` in the payload -- so the id an approval is decided by has to be
 * minted on this side -- and the answer schema is `decision.behavior`, not the
 * `permissionDecision` spelling `PreToolUse` uses, which Claude Code ignores
 * silently rather than refusing.
 *
 * Captured against **claude 2.1.278**. The pin matters: a newer CLI may add
 * fields, and the assertions below fail loudly rather than quietly recording a
 * payload nobody read. When one fails, look at what changed, decide what it
 * means for `claude-permission.ts`, and move the pin here and in that file's
 * test together.
 *
 * A test file so it runs under vitest; gated on an environment variable so an
 * ordinary run never spawns a provider or rewrites the fixture. To re-capture,
 * from packages/providers, on a machine with a logged-in Claude Code:
 *
 *   CAPTURE_FIXTURES=1 pnpm vitest run --config ../../scripts/vitest.config.ts \
 *     src/capture-claude-permission-fixture.test.ts
 */

/** The fixture this writes, read by `claude-permission.test.ts`. */
const FIXTURE = new URL('../fixtures/claude-permission-request.json', import.meta.url);

/**
 * What the agent is asked to propose: the epic's own example, and a command
 * that does nothing on this machine even if the hook were to let it through.
 * `prisma` is not installed, the schema path does not exist, and the hook
 * denies the call before either fact is reached.
 */
const PROPOSED_COMMAND = 'prisma migrate deploy --schema ./db';
const PROMPT = `Use the Bash tool to run exactly: ${PROPOSED_COMMAND}`;

/** Long enough for a real model turn, and bounded so a wedged CLI ends the run. */
const TURN_TIMEOUT_MS = 300_000;

/**
 * The keys claude 2.1.278 puts on the payload, in full.
 *
 * Asserted as a set rather than spot-checked, because the interesting failure
 * is the one nobody is looking for: a key appearing (`tool_use_id`, say, which
 * would change where an approval's identity comes from) or disappearing
 * (`permission_suggestions`, which AGX-129's policy grammar is read out of). A
 * capture that silently recorded either would be a fixture that proves the
 * opposite of what the code reading it assumes.
 */
const PAYLOAD_KEYS: readonly string[] = [
  'session_id',
  'transcript_path',
  'cwd',
  'prompt_id',
  'permission_mode',
  'effort',
  'hook_event_name',
  'tool_name',
  'tool_input',
  'permission_suggestions',
];

/**
 * The home and the working directory the fixture claims to have been taken in.
 *
 * `/Users/dev/Code/agentplex` is the same pretend machine
 * `claude-session-registry.json` was scrubbed onto, and the session id is the
 * one the transcript fixtures carry, so the captures describe one session on
 * one machine rather than three unrelated ones. Only paths and that id are
 * replaced; every key, every type and every other value is as Claude Code
 * wrote it.
 */
const FIXTURE_HOME = '/Users/dev';
const FIXTURE_CWD = `${FIXTURE_HOME}/Code/agentplex`;
const FIXTURE_SESSION_ID = '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde';

/**
 * How Claude Code names the transcript folder for a working directory: every
 * character that is not a letter or a digit becomes a hyphen. The captured
 * `transcript_path` carries the capture directory in that spelling as well as
 * plainly, so a scrub that replaced only the plain one would ship the
 * operator's home inside a folder name.
 */
function projectFolderName(directory: string): string {
  return directory.replace(/[^a-zA-Z0-9]/g, '-');
}

function scrubbed(raw: string, replacements: readonly (readonly [string, string])[]): string {
  let text = raw;
  for (const [from, to] of replacements) text = text.replaceAll(from, to);
  return text;
}

/**
 * The environment the captured `claude` runs in.
 *
 * The scrub is the adapter's own: a `claude` started from inside a Claude Code
 * session that still sees `CLAUDECODE` decides it is a nested run and behaves
 * differently, and a capture taken under those conditions is not a capture of
 * what a session started by agentplex is handed.
 *
 * `HOME` goes the other way, and this is the one file in the suite that
 * deliberately undoes `scripts/test-home.ts`. A throwaway home holds no login,
 * and only a logged-in Claude Code produces a real payload. `userInfo()` reads
 * the passwd entry rather than `$HOME`, so it finds the operator's real home
 * whatever the suite set. What the capture writes still goes nowhere near it:
 * the working directory is a throwaway, and the only thing left behind is the
 * transcript Claude Code keeps for the turn.
 */
function captureEnvironment(): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (CLAUDE_SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    environment[name] = value;
  }
  environment['HOME'] = userInfo().homedir;
  return environment;
}

/**
 * Runs the turn and resolves when the CLI is done, whatever it said.
 *
 * `stdio` gives the child no stdin at all rather than an open pipe: Claude
 * Code waits three seconds for piped input before deciding there is none, and
 * a capture should not be three seconds of waiting plus a warning on stderr.
 */
async function runTurn(argv: readonly string[], cwd: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(CLAUDE_COMMAND, [...argv], {
      shell: false,
      cwd,
      env: captureEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TURN_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${CLAUDE_COMMAND} exited ${String(code)}: ${stderr || stdout}`));
    });
  });
}

describe.runIf(process.env['CAPTURE_FIXTURES'] === '1')(
  'capturing a Claude Code PermissionRequest payload',
  () => {
    it(
      'runs a real turn and writes what the hook was handed',
      async () => {
        // `realpath` because macOS hands out `/var/folders/...` for a directory
        // whose real name is `/private/var/folders/...`, and it is the real one
        // that comes back in the payload and has to be scrubbed out of it.
        const scratch = await realpath(await mkdtemp(join(tmpdir(), 'agentplex-permission-')));
        try {
          // Written by the hook, read back below, and thrown away with
          // everything else the capture makes.
          const captured = join(scratch, 'captured.json');
          const hook = join(scratch, 'hook.sh');
          await writeFile(
            hook,
            [
              '#!/bin/sh',
              `cat > "${captured}"`,
              // Deny, so the proposed command cannot run even by accident, and
              // so the turn ends at the first tool call rather than going on to
              // do something else with the answer.
              "printf '%s' '" +
                JSON.stringify({
                  hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'deny', message: 'denied by the fixture capture' },
                  },
                }) +
                "'",
              '',
            ].join('\n'),
            'utf8',
          );
          await chmod(hook, 0o755);

          const settings = join(scratch, 'settings.json');
          await writeFile(
            settings,
            JSON.stringify({
              hooks: {
                PermissionRequest: [
                  { matcher: 'Bash', hooks: [{ type: 'command', command: hook, timeout: 60 }] },
                ],
              },
            }),
            'utf8',
          );

          await runTurn(
            [
              '--print',
              PROMPT,
              // Merged with the operator's own settings rather than replacing
              // them. This is the injection point the server will use, so the
              // capture goes through it too.
              '--settings',
              settings,
              // Without it, `--print` answers permission prompts itself and the
              // hook never fires.
              '--permission-mode',
              'manual',
            ],
            scratch,
          );

          const raw = await readFile(captured, 'utf8');
          const payload: unknown = JSON.parse(raw);
          expect(payload).toBeTypeOf('object');
          const record = payload as Record<string, unknown>;

          expect([...Object.keys(record)].sort()).toEqual([...PAYLOAD_KEYS].sort());
          // The claim the whole approvals design rests on. If this ever fails,
          // the id an approval is decided by can come from the provider and the
          // server no longer has to mint one -- which is a design decision, not
          // a fixture update.
          expect(record).not.toHaveProperty('tool_use_id');
          expect(record['hook_event_name']).toBe('PermissionRequest');
          expect(record['tool_name']).toBe('Bash');
          expect(record['tool_input']).toMatchObject({ command: PROPOSED_COMMAND });
          expect(record['permission_suggestions']).toMatchObject([{ type: 'addRules' }]);

          const sessionId = record['session_id'];
          expect(sessionId).toBeTypeOf('string');
          const home = userInfo().homedir;
          const fixture = scrubbed(raw, [
            [projectFolderName(scratch), projectFolderName(FIXTURE_CWD)],
            [scratch, FIXTURE_CWD],
            [home, FIXTURE_HOME],
            [String(sessionId), FIXTURE_SESSION_ID],
          ]);

          // The capture ran on somebody's machine and what it recorded goes into
          // a public repository. A path form the scrub did not know about fails
          // here rather than in review.
          expect(fixture).not.toContain(home);
          expect(fixture).not.toContain(scratch);
          expect(fixture).not.toContain(userInfo().username);

          await writeFile(FIXTURE, fixture, 'utf8');
          process.stdout.write(`wrote ${fileURLToPath(FIXTURE)}\n`);
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      },
      TURN_TIMEOUT_MS,
    );
  },
);
