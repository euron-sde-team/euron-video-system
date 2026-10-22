/**
 * `evs`: operator CLI for bootstrapping and break-glass administration.
 *
 * The first API key cannot be created through the API (there is no key yet to
 * authenticate with), so it is created here, directly against the database.
 *
 *   pnpm evs keys:create --name root --scopes '*' [--expires-days 90]
 *   pnpm evs keys:list
 *   pnpm evs keys:revoke <key-id>
 *   pnpm evs policies:list
 *
 * Every mutation is written to the audit log with actor_type 'cli'.
 */
import "dotenv/config";
import { closeDatabase, getDb } from "../packages/core/src/db/index.js";
import apiKeysRepository from "../apps/api/src/repositories/api-keys.repository.js";
import type { Actor } from "../apps/api/src/services/actor.js";
import { SCOPES, WILDCARD_SCOPE } from "../apps/api/src/services/api-key-format.js";
import apiKeysService from "../apps/api/src/services/api-keys.service.js";
import auditService from "../apps/api/src/services/audit.service.js";

const args = process.argv.slice(2);
const command = args[0];

const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// The CLI reuses the API's own services, so key generation, hashing and audit
// records are byte-for-byte what the API itself would produce.
const CLI_ACTOR: Actor = { type: "cli", id: process.env.USER ?? null, ipHash: null, requestId: null };

const audit = (action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>) =>
  auditService.record(CLI_ACTOR, action, { type: resourceType, id: resourceId }, metadata);

const usage = (): never => {
  console.log(`Usage:
  pnpm evs keys:create --name <name> --scopes <scope,scope|*> [--expires-days N]
  pnpm evs keys:list
  pnpm evs keys:revoke <key-id>
  pnpm evs policies:list

Scopes: ${[...SCOPES, WILDCARD_SCOPE].join(", ")}`);
  process.exit(command ? 1 : 0);
};

const keysCreate = async (): Promise<void> => {
  const name = flag("name");
  const scopesRaw = flag("scopes");
  if (!name || !scopesRaw) usage();
  const scopes = scopesRaw!.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = new Set<string>([...SCOPES, WILDCARD_SCOPE]);
  const unknown = scopes.filter((s) => !valid.has(s));
  if (unknown.length) throw new Error(`unknown scopes: ${unknown.join(", ")}`);

  const days = flag("expires-days");
  const expiresAt = days ? new Date(Date.now() + Number(days) * 86_400_000) : null;
  // creator = null: the CLI is the bootstrap path and may grant any scope.
  const { apiKey, secret } = await apiKeysService.create(null, { name: name!, scopes, expiresAt: expiresAt?.toISOString() ?? null });
  const id = apiKey.id;
  await audit("api_key.create", "api_key", id, { name, scopes });

  console.log(`\nCreated API key ${id} (${name})`);
  console.log(`  scopes:  ${scopes.join(", ")}`);
  console.log(`  expires: ${expiresAt ? expiresAt.toISOString() : "never"}`);
  console.log(`\n  ${secret}\n`);
  console.log("Store it now: it is shown once and cannot be recovered.\n");
};

const keysList = async (): Promise<void> => {
  const rows = await getDb()
    .selectFrom("api_keys")
    .select(["id", "name", "prefix", "scopes", "created_at", "expires_at", "revoked_at", "last_used_at"])
    .orderBy("created_at", "desc")
    .execute();
  console.table(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      key: `evs_${r.prefix}_…`,
      scopes: r.scopes.join(","),
      state: r.revoked_at ? "revoked" : r.expires_at && r.expires_at < new Date() ? "expired" : "active",
      lastUsed: r.last_used_at?.toISOString() ?? "never",
    }))
  );
};

const keysRevoke = async (): Promise<void> => {
  const id = args[1];
  if (!id) usage();
  if (!(await apiKeysRepository.revoke(id!))) throw new Error(`no active key with id ${id}`);
  await audit("api_key.revoke", "api_key", id!, {});
  console.log(`Revoked ${id}. Running API instances stop accepting it within 30 seconds.`);
};

const policiesList = async (): Promise<void> => {
  const rows = await getDb().selectFrom("playback_policies").selectAll().orderBy("is_default", "desc").execute();
  console.table(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      default: r.is_default,
      ttl: `${r.token_ttl_seconds}s (max ${r.max_token_ttl_seconds}s)`,
      origins: r.allowed_origins.length ? r.allowed_origins.join(",") : "any",
      maxSessions: r.max_concurrent_sessions || "unlimited",
    }))
  );
};

const commands: Record<string, () => Promise<void>> = {
  "keys:create": keysCreate,
  "keys:list": keysList,
  "keys:revoke": keysRevoke,
  "policies:list": policiesList,
};

const run = commands[command ?? ""];
if (!run) usage();

run!()
  .catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
