import path from "node:path";
import { config as loadEnv } from "dotenv";

// Load .env / .env.local for CLI usage (drizzle-kit, scripts) and for the
// Next.js node runtime. Keeping the loader here means `npx drizzle-kit push`
// works without a second, duplicated config file.
loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

// The connection string is configuration, never a committed constant.
const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is required. Copy .env.example to .env and set DATABASE_URL to your Postgres connection string.",
  );
}

const drizzleConfig = {
  dialect: "postgresql" as const,
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
};

export default drizzleConfig;
