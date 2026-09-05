import { PrivyAuthenticator, privyReader } from "@mandate/auth";
import { loadConfig } from "@mandate/config";
import { connectDatabase, databaseReady, Repository, workerAvailable } from "@mandate/database";
import { ASSETS, BaseReader } from "@mandate/evm";
import { AnthropicCompiler } from "@mandate/strategy";
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
      auth: new PrivyAuthenticator(
        config.privyAppId,
        privyReader(config.privyAppId, config.privyAppSecret),
      ),
      databaseReady: () => databaseReady(connection.db),
      workerAvailable: () => workerAvailable(connection.db),
      chainReady: () => chain.ready(),
      trading: {
        repository,
        chain,
        assets: ASSETS,
        compiler:
          config.anthropicKey && config.anthropicModel
            ? new AnthropicCompiler(config.anthropicKey, config.anthropicModel)
            : undefined,
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
