import { CachedAuthenticator, PrivyAuthenticator, privyReader } from "@mandate/auth";
import { loadConfig } from "@mandate/config";
import { connectDatabase, databaseReady, Repository, workerAvailable } from "@mandate/database";
import { ASSETS, BaseReader } from "@mandate/evm";
import { createCompiler } from "@mandate/strategy";
import { buildApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const connection = connectDatabase(config.databaseUrl);
  const repository = new Repository(connection.db);
  const chain = BaseReader.fromUrl(config.rpcUrl);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    app = await buildApp({
      config,
      users: repository,
      // Wrapped, not bare. Verification is two upstream Privy calls — verifyAccessToken plus
      // the linked-accounts read — on EVERY request, and the frontend polls /v1/me. Un-wrapped,
      // a user with three tabs open costs Privy six calls a second at steady state and a Privy
      // blip becomes a 503 for everyone. The cache holds verified identities for 60s, keyed by
      // token fingerprint rather than the token, and never caches a failure.
      auth: new CachedAuthenticator(
        new PrivyAuthenticator(
          config.privyAppId,
          privyReader(config.privyAppId, config.privyAppSecret),
        ),
      ),
      databaseReady: () => databaseReady(connection.db),
      workerAvailable: () => workerAvailable(connection.db),
      chainReady: () => chain.ready(),
      trading: {
        repository,
        chain,
        assets: ASSETS,
        // Undefined when no key is configured, which the draft route reports as text authoring
        // being unavailable while the structured builder carries on working.
        compiler: createCompiler(config.ai),
      },
    });
    app.addHook("onClose", () => connection.close());
    const server = app;
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => process.exit(1), 15_000);
      deadline.unref();
      void server.close().then(
        () => {
          clearTimeout(deadline);
          process.exitCode = 0;
        },
        () => {
          clearTimeout(deadline);
          process.exitCode = 1;
        },
      );
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    // Said out loud at startup, because the alternative is silent. The config schema only
    // requires these to be non-empty, so a placeholder boots a server that serves the public
    // market perfectly and answers 401 to every single sign-in — with the failure appearing in
    // the browser as "not signed in" rather than as "this deployment has no credentials".
    // A warning rather than a refusal: the public surface genuinely works without Privy, and
    // taking the whole API down over it would be the wrong trade in development.
    if (/placeholder|changeme|example/i.test(config.privyAppId))
      app.log.warn(
        { privyAppId: config.privyAppId },
        "PRIVY_APP_ID looks like a placeholder; every authenticated request will answer 401 until real credentials are set",
      );
    await app.listen({ host: config.host, port: config.port });
  } catch {
    if (app) await app.close();
    else await connection.close();
    throw new Error("API startup failed. Check configuration, port availability and dependencies.");
  }
}
main().catch(() => {
  // Do not print config validation inputs or SDK exceptions containing secrets.
  console.error(
    "Mandate API could not start. Check required environment settings and service availability.",
  );
  process.exitCode = 1;
});
