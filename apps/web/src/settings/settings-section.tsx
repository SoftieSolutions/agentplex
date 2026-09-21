import type { JSX, ReactNode } from 'react';
import { Paper } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';

/**
 * One bordered surface, the way every t7 panel sits on the background.
 *
 * It is its own file because two callers draw one: the settings screen, which
 * decides where its sections go, and the notifications control, which decides
 * whether it is on the screen at all. A control that can answer `null` cannot
 * be wrapped by its parent -- the wrapper would be an empty bordered box on
 * every browser without push -- so it carries its own surface, and copying
 * this into a second file would be two ideas of what a panel looks like.
 */
export function Section({
  scheme,
  children,
}: {
  readonly scheme: Scheme;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Paper
      withBorder
      radius="lg"
      p="md"
      style={{
        background: colorForRole('surface', scheme),
        borderColor: colorForRole('border', scheme),
      }}
    >
      {children}
    </Paper>
  );
}
