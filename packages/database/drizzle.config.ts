import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/database/src/schema/index.ts",
  out: "./packages/database/migrations",
  schemaFilter: ["mandate_v2"],
  strict: true,
});
