import { defineConfig } from "drizzle-kit";
import { readDatabaseUrl } from "./src/database-url.js";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: readDatabaseUrl(process.env),
  },
  strict: true,
  verbose: true,
});
