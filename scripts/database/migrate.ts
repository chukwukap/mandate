import { fileURLToPath } from "node:url";
import { migrateDatabase } from "../../packages/database/src/migrate.js";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url || !["postgres:", "postgresql:"].includes(new URL(url).protocol))
  throw new Error("Set MIGRATION_DATABASE_URL to the target PostgreSQL database.");
try {
  await migrateDatabase(
    url,
    fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url)),
  );
  console.log("Mandate API migrations applied.");
} catch {
  console.error("Migration failed. Check the target database and migration role permissions.");
  process.exitCode = 1;
}
