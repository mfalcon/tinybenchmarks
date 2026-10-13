// Pure harness logic: loading bites, templates, parsing, metrics and reports. No network.
import { readFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { parse } from "yaml";

export type MetricType = "exact" | "abs_error" | "match_rate";

export type Case = { vars: Record<string, unknown>; expected: Record<string, unknown> };
export type Bite = {
  name: string;
  dir: string; // folder of the YAML; `image` is resolved relative to it
  models: string[];
  prompt: string;
  image?: string;
  labels?: Record<string, string>;
  labelSet?: Set<string>; // normalized `labels` keys
  metrics: Record<string, MetricType[]>; // response JSON field → metrics
  cases: Case[];
};
export type Column = { name: string; field: string; type: MetricType };

export type Row = {
  model: string;
  case: number;
  repeat: number;
  prompt: string; // the full text sent to the model
  image?: string;
  expected: Record<string, unknown>;
  output?: string; // the full response
  finish_reason?: string;
  usage?: unknown;
  parsed?: unknown;
  json_ok?: boolean;
  off_label?: boolean;
  metrics: Record<string, number | null>;
  error?: string;
  ms: number;
};

// ---------- templates ----------

const VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

export function render(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(VAR_RE, (_, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new Error(`missing variable {{${name}}}`);
    return String(vars[name]);
  });
}

export function labelsText(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, desc]) => `- ${k}: ${desc}`)
    .join("\n");
}

// ---------- loading and validation (anything that fails here fails before spending tokens) ----------

export function loadBite(path: string): Bite {
  const fail = (msg: string): never => {
    throw new Error(`${path}: ${msg}`);
  };
  const raw = parse(readFileSync(path, "utf8")) ?? {};
  if (typeof raw.prompt !== "string") fail("missing 'prompt'");
  if (!raw.metrics) fail("missing 'metrics'");
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) fail("missing 'cases' (non-empty list)");
  if (raw.models !== undefined && !(Array.isArray(raw.models) && raw.models.every((m: unknown) => typeof m === "string"))) fail("'models' must be a list, e.g. [gpt-4.1]");

  const metrics: Record<string, MetricType[]> = {};
  for (const [field, spec] of Object.entries(raw.metrics)) {
    metrics[field] = [spec].flat() as MetricType[];
    for (const t of metrics[field]) if (!(t in METRICS)) fail(`unknown metric '${t}' in '${field}' (valid: ${Object.keys(METRICS).join(", ")})`);
  }

  const labelSet = raw.labels ? new Set(Object.keys(raw.labels).map(normalize)) : undefined;
  const templateVars = [...`${raw.prompt}\n${raw.image ?? ""}`.matchAll(VAR_RE)].map((m) => m[1]);

  const cases: Case[] = raw.cases.map(({ expected, ...vars }: Record<string, any>, i: number) => {
    const where = `case ${i + 1}`;
    if (!expected) fail(`${where}: missing 'expected'`);
    for (const [field, value] of Object.entries(expected)) {
      if (!metrics[field]) fail(`${where}: 'expected.${field}' has no metric in 'metrics'`);
      for (const t of metrics[field]) if (!EXPECTED_OK[t](value)) fail(`${where}: 'expected.${field}' must be ${EXPECTED_DESC[t]} for ${t} (got ${JSON.stringify(value)})`);
      if (labelSet && metrics[field].includes("exact") && !labelSet.has(normalize(value))) fail(`${where}: '${value}' is not in 'labels'`);
    }
    for (const v of templateVars) if (!Object.hasOwn(vars, v) && !(v === "labels" && labelSet)) fail(`${where}: missing variable {{${v}}}`);
    return { vars, expected };
  });

  return {
    name: basename(path, extname(path)),
    dir: dirname(path),
    models: raw.models ?? [],
    prompt: raw.prompt,
    image: raw.image,
    labels: raw.labels,
    labelSet,
    metrics,
    cases,
  };
}

// ---------- response parsing ----------

// Tolerates ```json fences and text around the object.
export function parseJson(text: string): Record<string, unknown> | null {
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  for (const candidate of [unfenced, unfenced.slice(unfenced.indexOf("{"), unfenced.lastIndexOf("}") + 1)]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {}
  }
  return null;
}

// ---------- metrics ----------

// Ignores case, accents and extra whitespace: "Sí " == "si".
export function normalize(v: unknown): string {
  return String(v).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");
}

const isScalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

// Only scalars are compared: objects or arrays never match (String() would turn any two into "[object Object]").
export function exact(actual: unknown, expected: unknown): number {
  return isScalar(actual) && isScalar(expected) && normalize(actual) === normalize(expected) ? 1 : 0;
}

// Accepts numbers and numeric strings ("7"); anything else (missing, "many", true, []) is null: no number to compare.
export function absError(actual: unknown, expected: unknown): number | null {
  const n = typeof actual === "number" ? actual : typeof actual === "string" && actual.trim() !== "" ? Number(actual) : NaN;
  const d = Math.abs(n - Number(expected));
  return Number.isFinite(d) ? d : null;
}

export function matchRate(actual: unknown, expected: unknown): number {
  if (!expected || typeof expected !== "object") return 0;
  const exp = expected as Record<string, unknown>;
  const keys = Object.keys(exp);
  if (keys.length === 0 || !actual || typeof actual !== "object") return 0;
  const act = actual as Record<string, unknown>;
  return keys.filter((k) => exact(act[k], exp[k]) === 1).length / keys.length;
}

const METRICS: Record<MetricType, (actual: unknown, expected: unknown) => number | null> = {
  exact,
  abs_error: absError,
  match_rate: matchRate,
};

// What each metric accepts as an expected value; checked when loading, before spending tokens.
const EXPECTED_OK: Record<MetricType, (v: unknown) => boolean> = {
  exact: isScalar,
  abs_error: (v) => typeof v === "number" && Number.isFinite(v),
  match_rate: (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0 && Object.values(v).every(isScalar),
};
const EXPECTED_DESC: Record<MetricType, string> = { exact: "a string, number or boolean", abs_error: "a number", match_rate: "an object of strings/numbers" };

// Column name: "field" if it has a single metric, "field.type" if it has several.
export function columns(bite: Bite): Column[] {
  return Object.entries(bite.metrics).flatMap(([field, types]) =>
    types.map((type) => ({ name: types.length === 1 ? field : `${field}.${type}`, field, type })),
  );
}

// Invalid JSON or missing field: exact/match_rate count as 0 (the task failed), abs_error stays null (no number).
export function scoreCase(bite: Bite, c: Case, parsed: Record<string, unknown> | null) {
  const metrics: Record<string, number | null> = {};
  let offLabel = false;
  for (const col of columns(bite)) {
    if (!(col.field in c.expected)) continue; // each case only scores the fields in its expected
    const actual = parsed?.[col.field];
    metrics[col.name] = METRICS[col.type](actual, c.expected[col.field]);
    if (col.type === "exact" && bite.labelSet && actual != null && !bite.labelSet.has(normalize(actual))) offLabel = true;
  }
  return { metrics, off_label: offLabel };
}

// ---------- reports ----------

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((100 * n) / d)}%`);

// One row per model. The ± is the standard deviation across repeats (mean of each repeat over
// all cases): it measures how much the result changes if you run again, not how hard the cases are.
export function summarize(bite: Bite, rows: Row[]): string {
  const cols = columns(bite);
  const header = ["model", ...cols.map((c) => (c.type === "abs_error" ? `${c.name} ↓` : c.name)), "invalid_json"];
  if (bite.labelSet) header.push("off_label");
  header.push("errors");

  const table = [header];
  for (const model of new Set(rows.map((r) => r.model))) {
    const mine = rows.filter((r) => r.model === model);
    const ok = mine.filter((r) => !r.error);
    const line = [model];
    for (const col of cols) {
      const byRepeat = new Map<number, number[]>();
      let unscored = 0; // abs_error is null when there's no number; averaging without them would reward skipping hard cases
      for (const r of ok) {
        const v = r.metrics[col.name];
        if (typeof v === "number") byRepeat.set(r.repeat, [...(byRepeat.get(r.repeat) ?? []), v]);
        else if (col.name in r.metrics) unscored++;
      }
      const means = [...byRepeat.values()].map(mean);
      let cell = means.length === 0 ? "—" : means.length === 1 ? means[0].toFixed(2) : `${mean(means).toFixed(2)} ± ${std(means).toFixed(2)}`;
      if (unscored) cell += ` (${unscored} unscored)`;
      line.push(cell);
    }
    line.push(pct(ok.filter((r) => !r.json_ok).length, ok.length));
    if (bite.labelSet) line.push(pct(ok.filter((r) => r.off_label).length, ok.length));
    line.push(String(mine.length - ok.length));
    table.push(line);
  }

  const widths = header.map((_, i) => Math.max(...table.map((l) => l[i].length)));
  return table.map((l) => l.map((cell, i) => cell.padEnd(widths[i])).join("   ").trimEnd()).join("\n");
}

// One call as readable markdown: full prompt, full response, expected and metrics.
// Uses ```` so the ``` that models return don't break the block.
export function transcriptEntry(r: Row): string {
  const fence = "````";
  const lines = [`## ${r.model} · case ${r.case} · repeat ${r.repeat + 1}`, ""];
  lines.push(`**Prompt**${r.image ? ` (+ image \`${r.image}\`)` : ""}`, fence, r.prompt, fence, "");
  if (r.error) lines.push(`**Error:** ${r.error}`, "");
  else {
    const notes = [r.finish_reason && r.finish_reason !== "stop" ? `finish_reason: ${r.finish_reason}` : "", r.json_ok ? "" : "invalid JSON"].filter(Boolean);
    lines.push(`**Response**${notes.length ? ` (${notes.join(", ")})` : ""}`, fence, r.output ?? "", fence, "");
  }
  lines.push(`**Expected:** \`${JSON.stringify(r.expected)}\` · **Metrics:** \`${JSON.stringify(r.metrics)}\``, "", "");
  return lines.join("\n");
}
