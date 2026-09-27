import { z } from 'zod';
import { machineOsSchema } from '@agentplex/protocol';
import type { CompletedProcess, Operation, OperationOutcome } from '@agentplex/providers';

/**
 * The name a Mac gives its own operating system: `macOS 26.6.2`, the one a
 * person recognises, rather than the `Darwin 25.6.0` the kernel answers to.
 *
 * Node cannot say it. `os.type()` and `os.release()` name the kernel, and the
 * kernel's version is not the product's -- nobody looking for "their Mac on 26"
 * finds it under 25. The product name lives in a plist that `sw_vers` reads, so
 * this asks `sw_vers`, once, at boot.
 *
 * The argv is fixed: the program and no arguments. `sw_vers` with none prints
 * every key it knows as `Key:<tabs>value` lines, which answers both halves of
 * the name with one child where `-productName` and `-productVersion` would
 * take two. The request is an empty strict object, so there is no field a
 * caller could put an argument in.
 *
 * Linux has no program for this and needs none: `/etc/os-release` is a file,
 * and reading a file is not a spawn. That half is `os-release.ts`, beside the
 * boot read that chooses between the two.
 */
export const osNameRequestSchema = z.strictObject({});
export type OsNameRequest = z.infer<typeof osNameRequestSchema>;

export const osNameOperation: Operation<OsNameRequest, string> = {
  name: 'system.os-name',
  summary: "The operating system's own product name and version, where sw_vers can say",
  request: osNameRequestSchema,

  argv: () => ({ file: 'sw_vers', args: [] }),

  /**
   * Two seconds. `sw_vers` reads one plist and exits; one that takes longer is
   * a machine in trouble, and the boot it sits in front of should not wait on
   * it for more than the kernel's name is worth.
   */
  timeoutMs: 2_000,

  read: readSwVers,
};

/** One `Key:<whitespace>value` line of `sw_vers` output. */
const LINE = /^(\w+):\s*(.*)$/;

function readSwVers(completed: CompletedProcess): OperationOutcome<string> {
  if (completed.exitCode !== 0) {
    return {
      ok: false,
      refusal: 'failed',
      problem: `sw_vers exited ${String(completed.exitCode)}`,
    };
  }

  const keys = new Map<string, string>();
  for (const line of completed.stdout.split('\n')) {
    const match = LINE.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) keys.set(match[1], match[2].trim());
  }

  const product = keys.get('ProductName') ?? '';
  const version = keys.get('ProductVersion') ?? '';
  if (product === '' || version === '') {
    return {
      ok: false,
      refusal: 'failed',
      problem: 'sw_vers printed no product name and version',
    };
  }

  // Checked against the wire's own rule here, where the refusal can still say
  // why, rather than letting a name the hub would refuse fail the handshake.
  const named = machineOsSchema.safeParse(`${product} ${version}`);
  if (!named.success) {
    return {
      ok: false,
      refusal: 'failed',
      problem: 'sw_vers printed a name this server will not send',
    };
  }

  return { ok: true, result: named.data };
}
