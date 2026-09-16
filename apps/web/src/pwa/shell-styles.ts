/**
 * The rule the document itself has to carry, as opposed to the thousands the
 * bundle brings with it.
 *
 * There is exactly one, and it is here rather than in `index.html` for the
 * reason the theme colour and the manifest link are: a value that means
 * something belongs in a module beside its argument, and the vite plugin puts
 * it in the head. Being in the head also makes it true before the bundle has
 * parsed, which for this rule is the whole point -- the first flick at a PWA
 * that is still starting up is exactly the one that would bounce.
 *
 * It is not the beginning of a stylesheet. Everything else this app draws is
 * drawn by a component, and a rule earns a place here only by being about the
 * viewport, which is the one surface no component owns.
 */

/**
 * What the viewport does when a gesture runs past the end of what there is to
 * scroll.
 *
 * `none` is two answers at once: no scroll chaining, and no overscroll
 * affordance -- which on iOS is the rubber-band, and on a PWA taken to a home
 * screen is the whole app peeling away from the top of the display while the
 * user is trying to read a terminal.
 *
 * It applies to the viewport, which is why it is on the root element and not
 * on the layout screen. The layout is `100dvh` with nothing overflowing it, so
 * the thing that bounces is not the layout: it is the page behind it, and the
 * page takes this declaration from `html`. Measured against the built app
 * before it was added -- both `html` and `body` computed `auto`, and the
 * document's scroll height was exactly its client height, so there was
 * nothing to scroll and every gesture that reached the page was an overscroll.
 *
 * `none` and not `contain`: `contain` keeps the affordance and only stops the
 * chaining, and the affordance is the half that is wrong here. It does not
 * stop anything scrolling -- the session list still scrolls, it simply stops
 * where it ends.
 */
export const SHELL_OVERSCROLL = 'none';

/** The document's own stylesheet, as the head will carry it. */
export function shellStyles(): string {
  return `html { overscroll-behavior: ${SHELL_OVERSCROLL}; }`;
}
