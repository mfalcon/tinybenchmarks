import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { absError, exact, loadBite, matchRate, normalize, parseJson, render, scoreCase, summarize, transcriptEntry, type Row } from "../lib.ts";
import { buildPrompt, chatRequest, runBite, type Prompt } from "../tb.ts";

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

test("runBite runs up to `concurrency` calls at once and keeps row order", async () => {
  const bite = loadBite(biteFile(CLASSIFY));
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = async (model: string, prompt: Prompt) => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    // the first model is the slowest, so its calls finish last
    await new Promise((r) => setTimeout(r, model === "a" ? 30 : 5));
    inFlight--;
    return { text: prompt.text.includes("woof") ? '{"label": "dog"}' : '{"label": "cat"}' };
  };
  const done: string[] = [];
  const rows = await runBite(bite, ["a", "b", "c"], 2, slow, (r) => done.push(r.model), 3);
  assert.equal(maxInFlight, 3);
  assert.notDeepEqual(done, rows.map((r) => r.model)); // completion order differs...
  assert.deepEqual(rows.map((r) => `${r.model}${r.repeat}${r.case}`), ["a01", "a02", "a11", "a12", "b01", "b02", "b11", "b12", "c01", "c02", "c11", "c12"]); // ...but rows don't
});

test("review fixes: render only uses the case's own variables", () => {
  assert.throws(() => render("{{constructor}}", {}), /missing variable \{\{constructor\}\}/);
  assert.throws(() => loadBite(biteFile(`prompt: "{{constructor}}"\nmetrics: {n: exact}\ncases:\n  - {expected: {n: 1}}\n`)), /missing variable/);
});

test("review fixes: exact and match_rate never match objects", () => {
  assert.equal(exact({ zzz: 99 }, { a: 1 }), 0);
  assert.equal(exact({ a: 1 }, "[object Object]"), 0);
  assert.equal(matchRate({ k: { zzz: 99 } }, { k: { a: 1 } }), 0);
  assert.equal(matchRate({ a: 1 }, null), 0);
});

test("review fixes: abs_error only scores numbers and numeric strings", () => {
  for (const v of [true, [], " ", null, {}]) assert.equal(absError(v, 1), null, JSON.stringify(v));
  assert.equal(absError("7", 6), 1);
  assert.equal(absError(0, 0), 0);
});

test("review fixes: loadBite rejects expected values of the wrong type, before any call", () => {
  const nums = (expected: string) => biteFile(`prompt: "{{q}}"\nmetrics: {n: abs_error, m: match_rate, e: exact}\ncases:\n  - {q: a, expected: ${expected}}\n`);
  assert.throws(() => loadBite(nums("{n: }")), /'expected.n' must be a number for abs_error/);
  assert.throws(() => loadBite(nums("{n: six}")), /'expected.n' must be a number/);
  assert.throws(() => loadBite(nums("{m: }")), /'expected.m' must be an object/);
  assert.throws(() => loadBite(nums("{m: dog}")), /'expected.m' must be an object/);
  assert.throws(() => loadBite(nums("{e: {a: 1}}")), /'expected.e' must be a string, number or boolean/);
  assert.throws(() => loadBite(biteFile(CLASSIFY.replace("models: [m1]", "models: m1"))), /'models' must be a list/);
});

test("review fixes: the table counts abs_error answers that had no number", async () => {
  const bite = loadBite(biteFile(`prompt: "{{q}}"\nmetrics: {n: abs_error}\ncases:\n  - {q: easy, expected: {n: 2}}\n  - {q: hard, expected: {n: 9}}\n`));
  // "skipper" answers the easy case exactly and dodges the hard one
  const fake = async (model: string, prompt: Prompt) => ({ text: prompt.text === "easy" ? '{"n": 2}' : model === "skipper" ? '{"n": "many"}' : '{"n": 8}' });
  const table = summarize(bite, await runBite(bite, ["skipper", "tries"], 1, fake)).split("\n");
  assert.match(table[1], /^skipper\s+0\.00 \(1 unscored\)\s/);
  assert.match(table[2], /^tries\s+0\.50\s/);
});

test("model@effort sends reasoning_effort; a bare name doesn't", () => {
  assert.deepEqual(chatRequest("gpt-6-astra@high", { text: "hi" }), { model: "gpt-6-astra", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" });
  assert.deepEqual(chatRequest("gpt-4.1", { text: "hi" }), { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] });
});
