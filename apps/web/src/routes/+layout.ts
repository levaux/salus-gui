/**
 * A single-page app: no server rendering, no prerendering.
 *
 * Everything this console shows is live fleet state, so there is nothing a
 * server could render that would still be true when it arrived.
 */
export const ssr = false;
export const prerender = false;
