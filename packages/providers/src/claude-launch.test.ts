import { storeIdSchema, type StoreDescriptor } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import {
  claudePermissionHook,
  planClaudeLaunch,
  CLAUDE_CONFIG_DIR,
  CLAUDE_SETTINGS_FILE_NAME,
} from './claude-launch.js';
import { planCodexLaunch } from './codex-launch.js';
import { CLAUDE_PERMISSION_HOOK_EVENT } from './claude-permission.js';
import type { LaunchApproval } from './provider-adapter.js';

/**
 * What a launch is once it can ask before it runs a tool.
 *
 * Three things are checked here and all three are about where a value ends up
 * rather than about what it says: the settings file is an argv element of its
 * own on a launch that has no shell, the secret is in the environment and not
 * on argv, and a provider with no hook is untouched by any of it.
 */

const STORE: StoreDescriptor = {
  storeId: storeIdSchema.parse('store-a'),
  path: '/Users/dev/.claude',
};
const CWD = '/Users/dev/Code/agentplex';

const APPROVAL: LaunchApproval = {
  settingsFile: '/var/lib/agentplex/approvals/launch-7.settings.json',
  env: {
    AGENTPLEX_APPROVAL_SOCKET: '/var/lib/agentplex/approvals.sock',
    AGENTPLEX_APPROVAL_SECRET: 'the-launch-secret',
  },
};

function plan(approval: LaunchApproval | null, args: readonly string[] = []) {
  const launch = planClaudeLaunch(STORE, CWD, args, approval);
  if (!launch.ok) throw new Error(launch.problem);
  return launch.plan;
}

describe('planning a claude launch that can ask', () => {
  it('names the per-launch settings file as its own argv element', () => {
    // Two elements and not one string. There is no shell on this path -- the
    // supervisor spawns the program directly -- so a settings path with a space
    // in it is a path and never two arguments.
    const { command, args } = plan(APPROVAL, ['--resume', 'session-a']);
    expect(command).toBe('claude');
    expect(args).toEqual(['--settings', APPROVAL.settingsFile, '--resume', 'session-a']);
  });

  it('puts the flag before whatever the caller asked for', () => {
    // A spawn's one argument is the user's prompt, which is content and may
    // begin with anything at all. Options first means the parse of this flag
    // cannot depend on what somebody typed into a start form.
    expect(plan(APPROVAL, ['fix the flaky test']).args).toEqual([
      '--settings',
      APPROVAL.settingsFile,
      'fix the flaky test',
    ]);
  });

  it('carries the secret in the environment and never on argv', () => {
    // `ps` reads another process's argv on every machine this runs on, and a
    // per-launch secret there would be readable by anything on the box -- which
    // is the one check standing between a local process and every session on
    // it. The environment of a child is not readable the same way.
    const { args, env } = plan(APPROVAL, ['--resume', 'session-a']);
    expect(args).not.toContain('the-launch-secret');
    expect(env['AGENTPLEX_APPROVAL_SECRET']).toBe('the-launch-secret');
    expect(env['AGENTPLEX_APPROVAL_SOCKET']).toBe('/var/lib/agentplex/approvals.sock');
  });

  it('still points the child at the store it was started in', () => {
    // The approval variables are additions and never a replacement: a launch
    // that lost `CLAUDE_CONFIG_DIR` would write its transcript into whichever
    // home the server runs as, and the store would never hear about it.
    expect(plan(APPROVAL, [])[`env`][CLAUDE_CONFIG_DIR]).toBe(STORE.path);
  });

  it('is exactly what it always was when there is nothing to ask through', () => {
    const { args, env } = plan(null, ['--resume', 'session-a']);
    expect(args).toEqual(['--resume', 'session-a']);
    expect(env).toEqual({ [CLAUDE_CONFIG_DIR]: STORE.path });
  });

  it('refuses a working directory the store owns, hook or no hook', () => {
    // The approval is an addition to a launch and not a way around one of its
    // rules: everything a launch can be refused for is still the directory.
    const launch = planClaudeLaunch(STORE, `${STORE.path}/projects`, [], APPROVAL);
    expect(launch.ok).toBe(false);
  });

  it('leaves a codex launch alone', () => {
    // The other provider has no hook to point anywhere, and nothing about this
    // reaches it: there is no settings file on its plan and no variable of ours
    // in its environment.
    const launch = planCodexLaunch(STORE, CWD, ['resume', 'session-a']);
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;
    expect(launch.plan.args).toEqual(['resume', 'session-a']);
    expect(Object.keys(launch.plan.env)).toEqual(['CODEX_HOME']);
  });
});

describe('the settings document that points the hook at this machine', () => {
  const document = (): unknown =>
    JSON.parse(
      claudePermissionHook.settings({
        command: '/usr/local/bin/node',
        args: ['/opt/agentplex/approval-hook.js'],
        timeoutSeconds: 600,
      }),
    );

  it('registers one command hook on the permission event, with its timeout', () => {
    expect(document()).toEqual({
      hooks: {
        [CLAUDE_PERMISSION_HOOK_EVENT]: [
          {
            hooks: [
              {
                type: 'command',
                command: `'/usr/local/bin/node' '/opt/agentplex/approval-hook.js'`,
                timeout: 600,
              },
            ],
          },
        ],
      },
    });
  });

  it('matches every tool by naming none', () => {
    // An omitted matcher is how this provider spells "every occurrence of the
    // event". A matcher naming tools would be agentplex deciding which of them
    // are worth asking about, which is the policy question of another ticket
    // and not a line in a launch.
    const entries = (document() as { hooks: Record<string, unknown[]> }).hooks[
      CLAUDE_PERMISSION_HOOK_EVENT
    ];
    expect(entries?.[0]).not.toHaveProperty('matcher');
  });

  it('quotes what the shell form of a hook command would otherwise split', () => {
    // The provider runs this string through `sh -c`, so a program path with a
    // space in it is two words unless it is quoted. Single quotes, because
    // nothing inside them is expanded: a path is a path and never a variable.
    const quoted = claudePermissionHook.settings({
      command: '/Applications/Node 24.app/node',
      args: ["/opt/agent's tools/hook.js"],
      timeoutSeconds: 600,
    });
    expect(JSON.parse(quoted)).toMatchObject({
      hooks: {
        [CLAUDE_PERMISSION_HOOK_EVENT]: [
          {
            hooks: [
              {
                command: `'/Applications/Node 24.app/node' '/opt/agent'\\''s tools/hook.js'`,
              },
            ],
          },
        ],
      },
    });
  });

  it('is written to a file named by the provider', () => {
    expect(claudePermissionHook.settingsFileName).toBe(CLAUDE_SETTINGS_FILE_NAME);
    expect(CLAUDE_SETTINGS_FILE_NAME.endsWith('.json')).toBe(true);
  });
});
