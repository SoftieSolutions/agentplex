import webPush from 'web-push';
import type { VapidKeyGenerator } from './push.js';

/**
 * The real VAPID key generator: a wrapper over `web-push`, and nothing else.
 *
 * It is here rather than inside `push.ts` so that the feature's rules -- mint
 * once, never expose the private half, degrade rather than throw -- are
 * testable without a cryptographic library in the test, and so that the one
 * place this application calls into `web-push` for a key is a file small enough
 * to read in one go. The composition root injects it, the same way it injects
 * the beacon source and the web assets.
 *
 * `import webPush from 'web-push'` and not a named import: the package is
 * CommonJS, its exports are an object assignment, and Node refuses
 * `import { generateVAPIDKeys }` from an ES module with "Named export
 * 'generateVAPIDKeys' not found". That was run, not assumed.
 *
 * What comes back is two strings, and the caller treats them as a claim: the
 * shape is checked where every other stored key is checked, which is in the
 * feature, so a library that one day returned something else fails at the same
 * parser a corrupt row does.
 */
export const nodeVapidKeyGenerator: VapidKeyGenerator = () => {
  const { publicKey, privateKey } = webPush.generateVAPIDKeys();
  return { publicKey, privateKey };
};
