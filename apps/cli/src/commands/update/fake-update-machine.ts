import {
  createFakeWriteMachine,
  type FakeWriteMachine,
  type FakeWriteMachineOptions,
} from '../../installation/fake-write-machine.js';
import type { UpdateMachine } from './update-machine.js';

/**
 * The write-machine fake `install` shares, with somebody at the terminal: the
 * one thing an update asks that an install does not.
 */
export interface FakeUpdateMachineOptions extends FakeWriteMachineOptions {
  /** What whoever is at this machine says, or nothing for a machine with nobody at it. */
  readonly answer?: 'yes' | 'no';
}

export interface FakeUpdateMachine extends FakeWriteMachine, UpdateMachine {
  /** Every question put to a person, in order. */
  readonly questions: readonly string[];
}

export function createFakeUpdateMachine(options: FakeUpdateMachineOptions = {}): FakeUpdateMachine {
  const questions: string[] = [];
  return {
    ...createFakeWriteMachine(options),
    questions,

    async askYesNo(question: string): Promise<'yes' | 'no' | 'nobody'> {
      questions.push(question);
      return options.answer ?? 'nobody';
    },
  };
}
