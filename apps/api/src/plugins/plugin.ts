import type { FastifyPluginAsync, FastifyPluginOptions } from "fastify";

export interface PluginMeta {
  /** Registered under this name; also what FST_ERR_PLUGIN_* errors report. */
  readonly name: string;
  /** Names of plugins that must already be registered on the parent instance. */
  readonly dependencies?: readonly string[];
}

/**
 * Local equivalent of `fastify-plugin`.
 *
 * `fastify-plugin` is not a dependency of @mandate/api and this workspace does not add
 * dependencies, so we set the three markers fastify reads directly. Verified against
 * apps/api/node_modules/fastify/lib/plugin-utils.js and plugin-override.js at 5.12.3:
 * `override()` calls `registerPlugin()` and returns the *parent* instance unchanged when
 * `Symbol.for("skip-override")` is truthy, instead of creating an encapsulating child.
 *
 * That is the whole point. Without the marker, `app.register(authentication)` builds a child
 * instance and the plugin's `onRequest` hook applies only to routes declared *inside* that
 * child — which is none of them. The API would boot, every test that only checks a happy path
 * would pass, and every /v1 route would be unauthenticated. This must never be a plain
 * `async (app) => {}` passed to register.
 *
 * Deliberately not forwarded from fastify-plugin's meta: `decorators`. Fastify's
 * `checkDecorators` runs at register time against the parent instance, so a plugin that
 * declares `decorators: { request: ["principal"] }` and then creates that decorator itself
 * throws FST_ERR_PLUGIN_NOT_PRESENT_IN_INSTANCE before its body ever runs.
 */
export function plugin<Options extends FastifyPluginOptions = FastifyPluginOptions>(
  fn: FastifyPluginAsync<Options>,
  meta: PluginMeta,
): FastifyPluginAsync<Options> {
  const define = (key: symbol, value: unknown) =>
    Object.defineProperty(fn, key, { value, configurable: true });
  define(Symbol.for("skip-override"), true);
  define(Symbol.for("fastify.display-name"), meta.name);
  // Cloned: fastify keeps a reference and `dependencies` is asserted to be an Array at
  // register time, so it must survive as a plain mutable-shaped object.
  define(Symbol.for("plugin-meta"), {
    name: meta.name,
    ...(meta.dependencies ? { dependencies: [...meta.dependencies] } : {}),
  });
  return fn;
}
