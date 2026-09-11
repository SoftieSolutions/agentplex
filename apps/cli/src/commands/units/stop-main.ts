import { main as runUnits } from './units-main.js';

/** `agentplex stop`, wired. The argument for the shape is in `start-main.ts`. */
export async function main(): Promise<void> {
  await runUnits('stop');
}
