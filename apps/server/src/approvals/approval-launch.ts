import { join } from 'node:path';
import type { IdGenerator, Logger } from '@agentplex/node-shared';
import type { StoreDescriptor } from '@agentplex/protocol';
import type { LaunchApproval, PermissionHook } from '@agentplex/providers';
import {
  APPROVAL_HOOK_TIMEOUT_SECONDS,
  type ApprovalGate,
  type ApprovalHookListener,
} from './approval-gate.js';
import { APPROVAL_SECRET_VARIABLE, APPROVAL_SOCKET_VARIABLE } from './approval-hook.js';

/**
 * What one launch needs on disk before it can ask anybody anything, and what
 * removing it looks like.
 *
 * The provider says what goes in the file and this writes it, which is the
 * division the whole approvals path is built on: a settings grammar is provider
 * knowledge, and a file with a lifetime, a mode and a removal is a machine's.
 * Nothing here reads what it writes.
 *
 * **A launch, not a session.** The folder and the secret are minted before the
 * agent starts and retired when its process ends, because at that moment there
 * is no session id to key on -- the provider mints its own and writes it to
 * disk moments later. Which session is asking comes from the payload, where the
 * provider states it.
 *
 * **An approval that cannot be prepared costs itself.** A disk that will not
 * take the file gives a launch with no hook in it: the agent starts, it works,
 * and it asks at its own terminal exactly as it would on a machine running no
 * agentplex. Refusing the session instead would take a person's work away over
 * a feature they may not have been about to use.
 */

/**
 * What every launch's folder name starts with, and so what a starting server
 * may remove from the approvals directory on sight.
 *
 * One name for both sides: a folder made here under any other prefix would
 * outlive the process that made it, and one swept under a looser prefix could
 * be something that is not a launch's at all.
 */
export const APPROVAL_LAUNCH_PREFIX = 'launch-';

/**
 * Everything a server needs to hold approvals, assembled where sockets may be
 * opened and handed over whole.
 *
 * One value rather than five dependencies, because they are one capability: a
 * socket, the path a hook is told to find it at, the folder both it and the
 * settings files live in, the disk under them, and the program a settings file
 * names. A server given some of them and not the others could point hooks at a
 * socket nothing is listening on.
 */
export interface ApprovalHooks {
  readonly listener: ApprovalHookListener;
  readonly socketPath: string;
  readonly directory: string;
  readonly files: ApprovalFileSystem;
  /** The program a provider runs, absolute, and the arguments before its own. */
  readonly hookCommand: string;
  readonly hookArgs: readonly string[];
}

/**
 * The disk under one launch's settings file.
 *
 * A seam of its own rather than a reuse of the store or grants filesystems, for
 * the reason each of those is its own: this one makes a folder per launch and
 * removes it whole, and neither belongs on a seam that reaches a provider's
 * volume or replaces one long-lived file.
 */
export interface ApprovalFileSystem {
  /** Writes a file nobody but this user can read, making its folder first. */
  write(path: string, content: string): Promise<void>;
  /** Removes a launch's folder, whatever is in it. Never throws. */
  removeDirectory(path: string): Promise<void>;
}

/** One launch's way of asking, and the end of it. */
export interface OpenLaunchApproval {
  readonly approval: LaunchApproval;
  /**
   * Retires the launch: the secret stops opening anything and the settings file
   * goes.
   *
   * Nothing is awaited by the caller -- it is called from the end of a process,
   * where there is nobody left to hand a rejection to -- so the removal is
   * reported to the log and never thrown.
   */
  close(): void;
}

export interface LaunchApprovals {
  /**
   * Prepares one launch, or answers `null` when there is nothing to prepare:
   * a provider with no hook, or a disk that would not take the file.
   */
  open(store: StoreDescriptor, hook: PermissionHook | null): Promise<OpenLaunchApproval | null>;
}

export interface LaunchApprovalsDependencies {
  readonly gate: ApprovalGate;
  readonly files: ApprovalFileSystem;
  /** The server's approvals directory, which the socket already lives in. */
  readonly directory: string;
  /** Where a hook connects, as it will be told in the launch's environment. */
  readonly socketPath: string;
  /** The program a provider's settings file names, absolute, and its arguments. */
  readonly hookCommand: string;
  readonly hookArgs: readonly string[];
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

export function createLaunchApprovals({
  gate,
  files,
  directory,
  socketPath,
  hookCommand,
  hookArgs,
  ids,
  logger,
}: LaunchApprovalsDependencies): LaunchApprovals {
  return {
    async open(
      store: StoreDescriptor,
      hook: PermissionHook | null,
    ): Promise<OpenLaunchApproval | null> {
      // codex, and every provider after it that cannot be made to ask. Nothing
      // is minted and nothing is written: its sessions produce no approvals,
      // which is a different thing from producing ones nobody can answer.
      if (hook === null) return null;

      // A folder per launch, so the file keeps the name the provider gave it
      // and the removal is one call on something nothing else is in.
      const folder = join(directory, `${APPROVAL_LAUNCH_PREFIX}${ids.newId()}`);
      const settingsFile = join(folder, hook.settingsFileName);
      const admission = gate.admit(store.storeId);

      try {
        await files.write(
          settingsFile,
          hook.settings({
            command: hookCommand,
            args: hookArgs,
            // The gate's own number. It expires a request shortly before this,
            // so that a decision is never written to a hook that has already
            // stopped reading -- and the two are one decision, stated once.
            timeoutSeconds: APPROVAL_HOOK_TIMEOUT_SECONDS,
          }),
        );
      } catch (error) {
        // The secret is retired immediately: a launch that will not carry the
        // file must not leave an admission behind that something else could
        // present.
        admission.close();
        logger.warn('a launch could not be given a way to ask', {
          storeId: store.storeId,
          problem: String(error),
        });
        return null;
      }

      return {
        approval: {
          settingsFile,
          env: {
            [APPROVAL_SOCKET_VARIABLE]: socketPath,
            // The one value here that is worth anything, and the reason it is
            // in the environment rather than on argv: `ps` shows one and not
            // the other.
            [APPROVAL_SECRET_VARIABLE]: admission.secret,
          },
        },

        close(): void {
          // The admission first. Whatever happens to the file, the secret stops
          // working the moment the launch is over, and anything the launch left
          // open is withdrawn rather than left in front of somebody as a
          // question that can no longer be answered.
          admission.close();
          void files.removeDirectory(folder).catch((error: unknown) => {
            // A settings file left behind is litter and not a leak -- its
            // secret is already dead -- so it is said once and not retried.
            logger.warn('a launch left its settings file behind', {
              folder,
              problem: String(error),
            });
          });
        },
      };
    },
  };
}
