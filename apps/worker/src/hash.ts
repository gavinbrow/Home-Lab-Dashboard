import { createHash } from "node:crypto";

/** Shared wire algorithm: recursively ordered object keys, array order unchanged. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value).replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value).replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${canonicalJson(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Request must contain finite JSON values only");
}
export function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }


