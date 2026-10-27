// Fixed SELECT-only probes. Never run expiry, object operations or mode changes.
import { DELETED_ASSETS_SQL } from "./storage-migration-cleanup.mjs";
import { storageHttpStatus } from "./storage-migration-diagnostics.mjs";

const trueRow = (rows, column) => Array.isArray(rows) && rows.length === 1 &&
  rows[0] !== null && typeof rows[0] === "object" && !Array.isArray(rows[0]) &&
  Object.keys(rows[0]).length === 1 && rows[0][column] === true;
const page = (rows) => Array.isArray(rows) && rows.length <= 200;
const probes = [
  { stage: "operator", sql: "SELECT public.media_is_operator() AS operator", validate: (rows) => trueRow(rows, "operator") },
  { stage: "null-read-only", sql: "SELECT $1::text IS NULL AS is_null", parameters: [null], validate: (rows) => trueRow(rows, "is_null") },
  { stage: "null-default", sql: "SELECT $1::text IS NULL AS is_null", parameters: [null], write: true, validate: (rows) => trueRow(rows, "is_null") },
  { stage: "string-read-only", sql: "SELECT $1::text = 'mfmf-probe' AS matches", parameters: ["mfmf-probe"], validate: (rows) => trueRow(rows, "matches") },
  { stage: "deleted-read-only", sql: DELETED_ASSETS_SQL, parameters: [null], validate: page },
  { stage: "deleted-default", sql: DELETED_ASSETS_SQL, parameters: [null], write: true, validate: page },
  { stage: "deleted-literal", sql: DELETED_ASSETS_SQL.replaceAll("$1::uuid", "NULL::uuid"), validate: page },
];
const shape = (value) => {
  if (Array.isArray(value)) return { resultType: "array", rowCount: value.length };
  return { resultType: value === null ? "null" : ["object", "string", "number", "boolean"].includes(typeof value) ? typeof value : "unknown" };
};

export async function diagnoseCleanup(query) {
  const results = [];
  for (const probe of probes) {
    try {
      const rows = await query(probe.sql, { parameters: probe.parameters ?? [], write: probe.write ?? false });
      results.push({ stage: probe.stage, outcome: probe.validate(rows) ? "pass" : "unexpected-result", ...shape(rows) });
    } catch (error) {
      const status = storageHttpStatus(error);
      results.push({ stage: probe.stage, outcome: "failed", ...(status === undefined ? {} : { httpStatus: status }) });
    }
  }
  return { operation: "storage-cleanup-diagnosis", probes: results, failures: results.filter((result) => result.outcome !== "pass").length };
}
