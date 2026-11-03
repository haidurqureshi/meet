// `npm run db:remote`
// 1. Finds (or creates) the D1 database named in wrangler.jsonc
// 2. Writes its id into wrangler.jsonc
// 3. Applies db/schema.sql to the REMOTE database (safe to re-run)
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CONFIG = "wrangler.jsonc";
const SCHEMA = "db/schema.sql";

function wrangler(args, { quiet = false } = {}) {
  // stdin is not a TTY on purpose, so wrangler never stops to ask questions.
  const res = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    // On Windows `npx` is really npx.cmd, which can only be started through a shell.
    shell: process.platform === "win32",
  });
  if (res.error) {
    // The command couldn't even start (not the same as wrangler failing).
    console.error(`Could not run wrangler: ${res.error.message}`);
  }
  if (!quiet) {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }
  return res;
}

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

let config = readFileSync(CONFIG, "utf8");
const nameMatch = config.match(/"database_name"\s*:\s*"([^"]+)"/);
if (!nameMatch) fail(`Could not find "database_name" in ${CONFIG}`);
const dbName = nameMatch[1];

function findDatabaseId() {
  const res = wrangler(["d1", "list", "--json"], { quiet: true });
  if (res.status !== 0) {
    process.stderr.write(res.stderr || "");
    process.stderr.write(res.stdout || "");
    fail(
      "Could not list your D1 databases. Are you logged in?\n" +
        "  Run:  npx wrangler login\n" +
        "  (or set CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)"
    );
  }
  const text = res.stdout.slice(res.stdout.indexOf("["));
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    fail("Could not understand the output of `wrangler d1 list --json`.");
  }
  const found = list.find((d) => d.name === dbName);
  return found ? found.uuid ?? found.id : null;
}

let id = findDatabaseId();
if (id) {
  console.log(`✔ Found D1 database "${dbName}" (${id})`);
} else {
  console.log(`Creating D1 database "${dbName}"…`);
  const created = wrangler(["d1", "create", dbName, "--location", "weur"]);
  if (created.status !== 0) fail("Creating the database failed (see above).");
  id = findDatabaseId();
  if (!id) fail("Database was created but its id could not be found.");
}

config = config.replace(/("database_id"\s*:\s*)"[^"]*"/, `$1"${id}"`);
writeFileSync(CONFIG, config);
console.log(`✔ Wrote database_id into ${CONFIG}`);

console.log(`Applying ${SCHEMA} to the remote database…`);
const exec = wrangler(["d1", "execute", dbName, "--remote", "--yes", "--file", SCHEMA]);
if (exec.status !== 0) fail("Applying the schema failed (see above).");

console.log("\n✔ Database ready. Next: npm run deploy");
