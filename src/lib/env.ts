import { config } from "dotenv";
import { z } from "zod";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

const defaultBackend =
  (process.env.DATABASE_BACKEND as "postgres" | "cloud-sqlite" | undefined) ??
  (process.env.DATABASE_URL ? "postgres" : "cloud-sqlite");

const schema = z
  .object({
    DATABASE_BACKEND: z.enum(["postgres", "cloud-sqlite"]).default(defaultBackend),
    DATABASE_URL: z.string().min(1).optional(),
    APP_URL: z.string().url().default("http://localhost:3000"),
    AUTH_MODE: z.enum(["password", "cloudflare-access"]).default("password"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    MAIL_TRANSPORT: z.enum(["console", "smtp", "manual"]).default("console"),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().min(3).optional(),
    ADMIN_EMAILS: z.string().default(""),
    SEED_DEMO: z.enum(["true", "false"]).default("false"),
    SEED_PASSWORD: z.string().optional(),
    DEBUG_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    WORKER_POLL_MS: z.coerce.number().int().positive().default(500),
    WORKER_NAME: z.string().optional(),
    REQUIRE_EMAIL_VERIFICATION: z.enum(["true", "false"]).default("false"),
    REGISTRATION_OPEN: z.enum(["true", "false"]).default("true"),
    AI_BASE_URL: z.string().optional(),
    AI_API_KEY: z.string().optional(),
    AI_MODEL: z.string().optional(),
    MERO_SHARE_ENCRYPTION_KEY: z
      .string()
      .optional()
      .refine(
        (value) => !value || Buffer.from(value, "base64").length === 32,
        "MERO_SHARE_ENCRYPTION_KEY must be a 32-byte base64 value."
      ),
    BACKUP_ENCRYPTION_KEY: z
      .string()
      .optional()
      .refine(
        (value) => !value || Buffer.from(value, "base64").length === 32,
        "BACKUP_ENCRYPTION_KEY must be a 32-byte base64 value."
      ),
    BACKUP_DIR: z.string().optional(),
    BACKUP_RETENTION: z.coerce.number().int().positive().default(7),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development")
  })
  .superRefine((value, ctx) => {
    if (value.DATABASE_BACKEND === "postgres" && !value.DATABASE_URL) {
      ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "Required for PostgreSQL" });
    }
    if (value.MAIL_TRANSPORT === "manual" && value.AUTH_MODE !== "cloudflare-access") {
      ctx.addIssue({
        code: "custom",
        path: ["MAIL_TRANSPORT"],
        message: "Manual invitations require Cloudflare Access authentication"
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

export function adminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS !== undefined ? process.env.ADMIN_EMAILS : env.ADMIN_EMAILS;
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function requireEmailVerification(): boolean {
  const val =
    process.env.REQUIRE_EMAIL_VERIFICATION !== undefined
      ? process.env.REQUIRE_EMAIL_VERIFICATION
      : env.REQUIRE_EMAIL_VERIFICATION;
  return val === "true";
}

export function registrationOpen(): boolean {
  const val =
    process.env.REGISTRATION_OPEN !== undefined
      ? process.env.REGISTRATION_OPEN
      : env.REGISTRATION_OPEN;
  return val === "true";
}

export function aiChatEnabled(): boolean {
  return Boolean(env.AI_BASE_URL && env.AI_MODEL);
}

export type BackupConfig = {
  /** Base64 32-byte key for encrypting backup archives; undefined disables backups. */
  encryptionKey: string | undefined;
  /** Directory backup archives are written to; undefined disables backups. */
  dir: string | undefined;
  /** How many of the most recent archives to keep. */
  retention: number;
};

/** Read live (like requireEmailVerification) so operators and tests can set it per-process. */
export function backupConfig(): BackupConfig {
  const retentionRaw =
    process.env.BACKUP_RETENTION !== undefined
      ? Number(process.env.BACKUP_RETENTION)
      : env.BACKUP_RETENTION;
  return {
    encryptionKey:
      process.env.BACKUP_ENCRYPTION_KEY !== undefined
        ? process.env.BACKUP_ENCRYPTION_KEY || undefined
        : env.BACKUP_ENCRYPTION_KEY,
    dir:
      process.env.BACKUP_DIR !== undefined ? process.env.BACKUP_DIR || undefined : env.BACKUP_DIR,
    retention:
      Number.isInteger(retentionRaw) && retentionRaw > 0 ? retentionRaw : env.BACKUP_RETENTION
  };
}
