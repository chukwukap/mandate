import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connectDatabase } from "./client.js";
export async function migrateDatabase(url: string, folder: string) {
  const connection = connectDatabase(url);
  try {
    await migrate(connection.db, {
      migrationsFolder: folder,
      migrationsSchema: "mandate_migrations",
    });
  } finally {
    await connection.close();
  }
}
