import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Contract test between the OpenAPI spec (which the API is held to by
 * openapi-drift.test.ts) and the console's hand-written response types.
 *
 * It exists because of a real bug: the API returned audit events as nested
 * `actor` / `resource` objects while the console read flat `actorType` /
 * `resourceId` fields. Both sides passed their own tests and the audit page
 * rendered empty columns. Any field the console reads must exist in the spec.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
interface Schema {
  $ref?: string;
  properties?: Record<string, unknown>;
  allOf?: Schema[];
}
const spec = parse(readFileSync(path.join(ROOT, "docs/api/openapi.yaml"), "utf8")) as {
  components: { schemas: Record<string, Schema> };
};
const consoleTypes = readFileSync(path.join(ROOT, "apps/console/src/lib/types.ts"), "utf8");

/** Top-level field names of an exported console interface (nested object members excluded). */
const consoleFields = (name: string): string[] => {
  const m = consoleTypes.match(new RegExp(`export (?:interface|type) ${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`));
  if (!m?.[1]) throw new Error(`console type ${name} not found`);
  const fields: string[] = [];
  let depth = 0;
  for (const line of m[1].split("\n")) {
    const field = depth === 0 ? line.match(/^\s+(\w+)\??:/)?.[1] : undefined;
    if (field) fields.push(field);
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return fields;
};

/** Every property a schema declares, following $ref and allOf composition. */
const collectProps = (schema: Schema, seen = new Set<string>()): string[] => {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    if (seen.has(name)) return [];
    seen.add(name);
    const target = spec.components.schemas[name];
    if (!target) throw new Error(`unresolved $ref ${schema.$ref}`);
    return collectProps(target, seen);
  }
  return [...Object.keys(schema.properties ?? {}), ...(schema.allOf ?? []).flatMap((s) => collectProps(s, seen))];
};

const specFields = (name: string): Set<string> => {
  const schema = spec.components.schemas[name];
  if (!schema) throw new Error(`spec schema ${name} not found`);
  return new Set(collectProps(schema));
};

/** console type -> OpenAPI schema. Add a row when the console starts reading a new resource. */
const PAIRS: Array<[consoleType: string, specSchema: string]> = [
  ["Video", "Video"],
  ["Stats", "Stats"],
  ["PlaybackSessionGrant", "PlaybackSessionMinted"],
  ["PlaybackSession", "PlaybackSession"],
  ["PlaybackPolicy", "PlaybackPolicy"],
  ["ApiKey", "ApiKey"],
  ["Webhook", "WebhookEndpoint"],
  ["WebhookDelivery", "WebhookDelivery"],
  ["AuditEvent", "AuditEvent"],
  ["UsageDay", "UsageDay"],
];

describe("console types read only fields the API contract defines", () => {
  it.each(PAIRS)("console %s ⊆ spec %s", (consoleType, specSchema) => {
    const declared = specFields(specSchema);
    const unknown = consoleFields(consoleType).filter((f) => !declared.has(f));
    expect(unknown, `console ${consoleType} reads fields missing from spec ${specSchema}`).toEqual([]);
  });
});
