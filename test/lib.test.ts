import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { absError, exact, loadBite, matchRate, normalize, parseJson, render, scoreCase, summarize, transcriptEntry, type Row } from "../lib.ts";
import { buildPrompt, runBite, type Prompt } from "../tb.ts";

const dir = mkdtempSync(join(tmpdir(), "tb-test-"));
function biteFile(yaml: string): string {
  const p = join(dir, `bite-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(p, yaml);
  return p;
}

const CLASSIFY = `
models: [m1]
labels: {dog: "a dog", cat: "a cat"}
prompt: "Animal: {{sound}}\\n{{labels}}"
metrics: {label: exact}
cases:
  - {sound: woof, expected: {label: dog}}
  - {sound: meow, expected: {label: cat}}
`;

test("render replaces variables and fails on a missing one", () => {
  assert.equal(render('Hi {{ name }}, JSON: {"a": 1}', { name: "Ana" }), 'Hi Ana, JSON: {"a": 1}');
  assert.throws(() => render("{{missing}}", {}), /missing variable/);
});

test("parseJson tolerates fences and surrounding text", () => {
  assert.deepEqual(parseJson('{"n": 3}'), { n: 3 });
  assert.deepEqual(parseJson('```json\n{"n": 3}\n```'), { n: 3 });
  assert.deepEqual(parseJson('Sure! {"n": 3} done'), { n: 3 });
  assert.equal(parseJson("no idea"), null);
  assert.equal(parseJson("[1,2]"), null);
});

test("normalize ignores case, accents and whitespace", () => {
  assert.equal(normalize("  Sí  señor "), "si senor");
});

test("metrics", () => {
  assert.equal(exact("None ", "none"), 1);
  assert.equal(exact(undefined, "x"), 0);
  assert.equal(exact(6, "6"), 1);
  assert.equal(absError(4, 6), 2);
  assert.equal(absError("7", 6), 1);
  assert.equal(absError("many", 6), null);
  assert.equal(absError(undefined, 6), null);
  assert.equal(matchRate({ a: 1, b: 2 }, { a: 1, b: 3 }), 0.5);
  assert.equal(matchRate("x", { a: 1 }), 0);
});

test("loadBite validates labels, metrics and variables", () => {
  assert.equal(loadBite(biteFile(CLASSIFY)).cases.length, 2);
  assert.throws(() => loadBite(biteFile(CLASSIFY.replace("label: cat}", "label: catt}"))), /'catt' is not in 'labels'/);
  assert.throws(() => loadBite(biteFile(CLASSIFY.replace("{label: exact}", "{label: fuzzy}"))), /unknown metric 'fuzzy'/);
  assert.throws(() => loadBite(biteFile(CLASSIFY.replace("{{sound}}", "{{snd}}"))), /missing variable \{\{snd\}\}/);
  assert.throws(() => loadBite(biteFile(CLASSIFY.replace("expected: {label: dog}", "expected: {other: dog}"))), /has no metric/);
});

test("scoreCase: invalid JSON gives 0 for exact and null for abs_error; flags off_label", () => {
  const bite = loadBite(biteFile(CLASSIFY));
  assert.deepEqual(scoreCase(bite, bite.cases[0], null).metrics, { label: 0 });
  assert.equal(scoreCase(bite, bite.cases[0], { label: "cow" }).off_label, true);
  assert.equal(scoreCase(bite, bite.cases[0], { label: "Dog" }).off_label, false);

  const nums = loadBite(biteFile(`
prompt: "{{q}}"
metrics: {n: [abs_error, exact], ok: exact}
cases:
  - {q: a, expected: {n: 5}}
  - {q: b, expected: {ok: "yes"}}
`));
  assert.deepEqual(scoreCase(nums, nums.cases[0], null).metrics, { "n.abs_error": null, "n.exact": 0 });
  assert.deepEqual(scoreCase(nums, nums.cases[0], { n: 4 }).metrics, { "n.abs_error": 1, "n.exact": 0 });
  assert.deepEqual(scoreCase(nums, nums.cases[1], { ok: "Yes" }).metrics, { ok: 1 }); // only scores the case's own fields
});

test("runBite + summarize with a fake model", async () => {
  const bite = loadBite(biteFile(CLASSIFY));
  const fake = async (model: string, prompt: Prompt, repeat: number) => {
    if (model === "broken") throw new Error("it crashed");
    if (model === "chatty") return { text: "I think it is a dog" };
    // "good" is always right; "mid" gets the dog, and the cat only on repeat 1
    if (prompt.text.includes("woof")) return { text: '{"label": "dog"}' };
    return { text: model === "good" || repeat === 1 ? '{"label": "cat"}' : '{"label": "dog"}' };
  };
  const rows: Row[] = await runBite(bite, ["good", "mid", "chatty", "broken"], 2, fake);
  assert.equal(rows.length, 4 * 2 * 2);

  const table = summarize(bite, rows).split("\n");
  assert.match(table[0], /model\s+label\s+invalid_json\s+off_label\s+errors/);
  assert.match(table[1], /^good\s+1\.00 ± 0\.00\s+0%\s+0%\s+0$/);
  assert.match(table[2], /^mid\s+0\.75 ± 0\.25\s+0%\s+0%\s+0$/);
  assert.match(table[3], /^chatty\s+0\.00 ± 0\.00\s+100%\s+0%\s+0$/);
  assert.match(table[4], /^broken\s+—\s+—\s+—\s+4$/);

  // the .md shows the full prompt (with labels already filled in) and the full response
  const md = transcriptEntry(rows.find((r) => r.model === "chatty")!);
  assert.match(md, /Animal: woof\n- dog: a dog\n- cat: a cat/);
  assert.match(md, /\*\*Response\*\* \(invalid JSON\)\n````\nI think it is a dog\n````/);
  assert.match(transcriptEntry(rows.find((r) => r.model === "broken")!), /\*\*Error:\*\* it crashed/);
});

test("the repo's bites load and their images exist", () => {
  const bitesDir = join(import.meta.dirname, "..", "bites");
  for (const f of readdirSync(bitesDir).filter((f) => f.endsWith(".yaml"))) {
    const bite = loadBite(join(bitesDir, f));
    for (const c of bite.cases) buildPrompt(bite, c.vars);
  }
});
