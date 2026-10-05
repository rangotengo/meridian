#!/usr/bin/env node
/**
 * Meridian cloud operator CLI. Reaches the operator-only Durable Object
 * endpoints (`/__meridian/ops/*`) on the public hostname by presenting the
 * `MERIDIAN_OPS_TOKEN` Worker secret; without that secret the worker serves
 * the stock 404 for those paths.
 *
 * Examples (Node 22+):
 *   MERIDIAN_OPS_TOKEN=... node bin/cloud-ops.mjs status
 *   MERIDIAN_OPS_TOKEN=... node bin/cloud-ops.mjs bookmark --time 2026-10-04T12:00:00Z
 *   MERIDIAN_OPS_TOKEN=... node bin/cloud-ops.mjs export --out meridian-backup.json
 *   MERIDIAN_OPS_TOKEN=... node bin/cloud-ops.mjs restore --time 2026-10-04T12:00:00Z          # dry run
 *   MERIDIAN_OPS_TOKEN=... node bin/cloud-ops.mjs restore --time 2026-10-04T12:00:00Z --yes    # restore
 *   MERIDIAN_OPS_TOKEN=... node bin/cloud-ops.mjs restore --bookmark <undo-bookmark> --yes     # undo a restore
 *
 * Never put the token, MERO_SHARE_ENCRYPTION_KEY or any other secret in
 * command history or files you commit. The export contains database rows
 * only (credential columns are ciphertext); encrypt it offline, e.g.
 *   gpg --symmetric --output meridian-backup.json.gpg meridian-backup.json
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const command = args[0];

function opt(name) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}
function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const baseUrl = (
  opt("url") ??
  process.env.MERIDIAN_OPS_URL ??
  "https://meridian.arunshrestha.info.np"
).replace(/\/$/, "");
const token = opt("token") ?? process.env.MERIDIAN_OPS_TOKEN;
if (!token) die("Set the MERIDIAN_OPS_TOKEN Worker secret in the environment or pass --token.");
const headers = { "x-meridian-ops-token": token };
// Cloudflare Access guards the whole hostname, so production calls also need
// an Access service token; without one Access answers with its login page.
const accessId = process.env.CF_ACCESS_CLIENT_ID;
const accessSecret = process.env.CF_ACCESS_CLIENT_SECRET;
if (accessId && accessSecret) {
  headers["CF-Access-Client-Id"] = accessId;
  headers["CF-Access-Client-Secret"] = accessSecret;
}

async function call(pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) }
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function assertOk({ status, body }, what) {
  if (status !== 200) die(`${what} failed (HTTP ${status}): ${JSON.stringify(body)}`);
  return body;
}

async function status() {
  const body = assertOk(await call("/__meridian/ops/status"), "status");
  console.log(JSON.stringify(body, null, 2));
  if (body.lastTickAt) {
    const ageMin = Math.round((Date.now() - Date.parse(body.lastTickAt)) / 60000);
    console.log(`Last cron tick: ${ageMin} minute(s) ago (cron runs every 5 minutes)`);
  }
}

async function bookmark() {
  const time = opt("time");
  const bookmarkValue = opt("bookmark");
  if (!time && !bookmarkValue) die("Pass --time <iso-8601|epoch-ms> or --bookmark <bookmark>.");
  const search = bookmarkValue
    ? `?bookmark=${encodeURIComponent(bookmarkValue)}`
    : `?time=${encodeURIComponent(time)}`;
  console.log(
    JSON.stringify(assertOk(await call(`/__meridian/ops/bookmark${search}`), "bookmark"), null, 2)
  );
}

async function exportSnapshot() {
  const out =
    opt("out") ?? `meridian-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const body = assertOk(await call("/__meridian/ops/export"), "export");
  const counts = Object.fromEntries(
    Object.entries(body.tables).map(([name, rows]) => [name, rows.length])
  );
  await writeFile(out, JSON.stringify(body));
  console.log(`Snapshot written to ${out}`);
  console.log("Rows per table:", JSON.stringify(counts));
  console.log("Encrypt and move it offline, then delete the plaintext copy, e.g.:");
  console.log(`  gpg --symmetric --output ${out}.gpg ${out} && rm ${out}`);
}

async function restore() {
  const time = opt("time");
  const bookmarkValue = opt("bookmark");
  if (!time && !bookmarkValue) die("Pass --time <iso-8601|epoch-ms> or --bookmark <bookmark>.");
  const search = bookmarkValue
    ? `?bookmark=${encodeURIComponent(bookmarkValue)}`
    : `?time=${encodeURIComponent(time)}`;

  const dry = assertOk(await call(`/__meridian/ops/bookmark${search}`), "restore dry run");
  console.log("Dry run (nothing changed):");
  console.log(JSON.stringify(dry, null, 2));
  if (!opt("yes")) {
    console.log("Re-run with --yes to restore the Durable Object to targetBookmark.");
    return;
  }

  // The restore wipes everything written after targetBookmark, including the
  // in-database audit row and any in-database copy of the undo bookmark.
  // Record it offline BEFORE restoring.
  const logFile = opt("log") ?? path.join("logs", "cloud-ops.jsonl");
  await mkdir(path.dirname(logFile), { recursive: true });
  await appendFile(
    logFile,
    `${JSON.stringify({
      at: new Date().toISOString(),
      kind: "restore",
      targetTime: dry.targetTime,
      targetBookmark: dry.targetBookmark,
      undoBookmark: dry.undoBookmark,
      command: process.argv.join(" ")
    })}\n`
  );
  console.log(`Undo bookmark ${dry.undoBookmark} saved to ${logFile}.`);

  let outcome;
  try {
    const result = await call(`/__meridian/ops/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bookmarkValue ? { bookmark: bookmarkValue } : { time })
    });
    outcome = `HTTP ${result.status}: ${JSON.stringify(result.body)}`;
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? "";
    outcome = `connection ended${code ? ` (${code})` : ""} — expected: the Durable Object restarts into the restored state.`;
  }
  console.log(`Restore request: ${outcome}`);

  console.log("Waiting for the object to come back...");
  let back = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const s = await call("/__meridian/ops/status");
      if (s.status === 200) {
        back = s.body;
        break;
      }
    } catch {
      /* keep waiting */
    }
  }
  if (!back)
    die("The object did not answer /status within 60 seconds — check the Cloudflare dashboard.");

  const logged = await call(`/__meridian/ops/restore-log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetTime: dry.targetTime,
      targetBookmark: dry.targetBookmark,
      undoBookmark: dry.undoBookmark
    })
  });
  console.log(
    logged.status === 200
      ? "Post-restore audit event (ops.restore_completed) written to the restored database."
      : `Warning: could not write the post-restore audit event (HTTP ${logged.status}).`
  );
  console.log(`Post-restore status: ${JSON.stringify(back)}`);
  console.log(
    `To UNDO this restore: node bin/cloud-ops.mjs restore --bookmark ${dry.undoBookmark} --yes`
  );
}

const commands = { status, bookmark, export: exportSnapshot, restore };
if (!commands[command]) {
  die(
    `Usage: node bin/cloud-ops.mjs <status|bookmark|export|restore> [options]\nOptions: --url, --token, --time, --bookmark, --out, --log, --yes`
  );
}
await commands[command]();
