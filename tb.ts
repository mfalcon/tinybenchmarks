// CLI: node tb.ts <bite> [--models a,b] [--repeats n] [--concurrency n]
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Bite, type Row, labelsText, loadBite, parseJson, render, scoreCase, summarize, transcriptEntry } from "./lib.ts";

const ROOT = import.meta.dirname;
const BASE_URL = process.env.TB_BASE_URL ?? "https://api.openai.com/v1";
const API_KEY = process.env.TB_API_KEY ?? process.env.OPENAI_API_KEY;
const TIMEOUT_S = Number(process.env.TB_TIMEOUT ?? 180); // per attempt; a hung call is retried like a network error

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

export type Prompt = { text: string; image?: string }; // image: absolute path
export type Reply = { text: string; finish_reason?: string; usage?: unknown };
export type ChatFn = (model: string, prompt: Prompt, repeat: number) => Promise<Reply>;

export function buildPrompt(bite: Bite, vars: Record<string, unknown>): Prompt {
  const all = bite.labels ? { ...vars, labels: labelsText(bite.labels) } : vars;
  const text = render(bite.prompt, all);
  if (!bite.image) return { text };
  const image = resolve(bite.dir, render(bite.image, all));
  if (!MIME[extname(image).toLowerCase()]) throw new Error(`unsupported image format: ${image}`);
  if (!existsSync(image)) throw new Error(`image not found: ${image}`);
  return { text, image };
}

function messageContent(p: Prompt) {
  if (!p.image) return p.text;
  const url = `data:${MIME[extname(p.image).toLowerCase()]};base64,${readFileSync(p.image).toString("base64")}`;
  return [
    { type: "text", text: p.text },
    { type: "image_url", image_url: { url } },
  ];
}

// Calls an OpenAI-compatible endpoint, with a disk cache and 3 attempts (only on network errors, 429 or 5xx).
// The repeat number is part of the cache key: otherwise all N repeats would return the same response.
export const chat: ChatFn = async (model, prompt, repeat) => {
  const request = { model, messages: [{ role: "user", content: messageContent(prompt) }] };
  const key = createHash("sha256").update(JSON.stringify({ BASE_URL, body: request, repeat })).digest("hex");
  const file = join(ROOT, ".cache", `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(TIMEOUT_S * 1000),
    }).catch((e: Error) => e);
    if (!(res instanceof Error) && res.ok) {
      const data = await res.json();
      const reply: Reply = { text: data.choices[0].message.content ?? "", finish_reason: data.choices[0].finish_reason, usage: data.usage };
      mkdirSync(join(ROOT, ".cache"), { recursive: true });
      writeFileSync(file, JSON.stringify({ model, repeat, ...reply }));
      return reply;
    }
    const failure = res instanceof Error ? (res.name === "TimeoutError" ? `timeout after ${TIMEOUT_S}s` : `network error: ${res.message}`) : `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
    const retryable = res instanceof Error || res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 3) throw new Error(failure);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
  }
};

// Runs up to `concurrency` calls at a time. onRow fires in completion order; the returned rows
// keep the model → repeat → case order regardless of which call finished first.
export async function runBite(bite: Bite, models: string[], repeats: number, chatFn: ChatFn, onRow?: (r: Row) => void, concurrency = 8): Promise<Row[]> {
  const prompts = bite.cases.map((c) => buildPrompt(bite, c.vars)); // fails before spending tokens if an image is missing
  const tasks = models.flatMap((model) => Array.from({ length: repeats }, (_, repeat) => bite.cases.map((c, i) => ({ model, repeat, c, i }))).flat());
  const rows: Row[] = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const t = next++;
      const { model, repeat, c, i } = tasks[t];
      const p = prompts[i];
      const base = { model, case: i + 1, repeat, prompt: p.text, image: p.image && relative(ROOT, p.image), expected: c.expected };
      const t0 = Date.now();
      try {
        const reply = await chatFn(model, p, repeat);
        const parsed = parseJson(reply.text);
        rows[t] = { ...base, output: reply.text, finish_reason: reply.finish_reason, usage: reply.usage, parsed, json_ok: parsed !== null, ...scoreCase(bite, c, parsed), ms: Date.now() - t0 };
      } catch (e) {
        rows[t] = { ...base, metrics: {}, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
      }
      onRow?.(rows[t]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return rows;
}

function resolveBitePath(arg: string): string {
  for (const p of [arg, join(ROOT, "bites", `${arg}.yaml`)]) if (p.endsWith(".yaml") && existsSync(p)) return p;
  throw new Error(`bite '${arg}' not found (tried ${arg} and bites/${arg}.yaml)`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { models: { type: "string" }, repeats: { type: "string", default: "1" }, concurrency: { type: "string", default: "8" } },
  });
  if (positionals.length !== 1) throw new Error("usage: node tb.ts <bite> [--models a,b] [--repeats n] [--concurrency n]");
  const bite = loadBite(resolveBitePath(positionals[0]));
  const models = values.models ? values.models.split(",").map((m) => m.trim()) : bite.models;
  const repeats = Number(values.repeats);
  const concurrency = Number(values.concurrency);
  if (models.length === 0) throw new Error("no models: set 'models' in the YAML or pass --models");
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be an integer ≥ 1");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be an integer ≥ 1");
  if (!API_KEY) throw new Error("missing OPENAI_API_KEY (or TB_API_KEY)");
  if (!(TIMEOUT_S > 0)) throw new Error("TB_TIMEOUT must be a number of seconds > 0");

  // .jsonl to process, .md to read: both are written as responses arrive.
  mkdirSync(join(ROOT, "runs"), { recursive: true });
  const stem = join(ROOT, "runs", `${bite.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  writeFileSync(`${stem}.md`, `# ${bite.name} — ${models.join(", ")} × ${repeats} repeats\n\n`);
  const total = models.length * repeats * bite.cases.length;
  let done = 0;

  const rows = await runBite(bite, models, repeats, chat, (r) => {
    appendFileSync(`${stem}.jsonl`, JSON.stringify(r) + "\n");
    appendFileSync(`${stem}.md`, transcriptEntry(r));
    const status = r.error ? `ERROR ${r.error}` : !r.json_ok ? "invalid JSON" : Object.entries(r.metrics).map(([k, v]) => `${k}=${v}`).join(" ");
    console.error(`[${++done}/${total}] ${r.model} repeat ${r.repeat + 1} case ${r.case}  ${(r.ms / 1000).toFixed(1)}s  ${status}`);
  }, concurrency);

  console.log(`\n${bite.name} — ${bite.cases.length} cases × ${repeats} repeats\n`);
  console.log(summarize(bite, rows));
  console.log(`\nprompts and responses: ${relative(process.cwd(), `${stem}.md`)}\ndetails (jsonl):       ${relative(process.cwd(), `${stem}.jsonl`)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
