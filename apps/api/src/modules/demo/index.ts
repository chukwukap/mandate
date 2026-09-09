/**
 * The demo deployment's faucet.
 *
 * Isolated in its own module because it is the one route that writes chain state directly, and
 * a reader deciding whether a deployment can hand out funds should be able to answer it by
 * looking at whether this module is registered at all.
 */
export { registerDemo } from "./routes.js";
