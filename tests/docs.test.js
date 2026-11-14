/**
 * Documentation drift guard: every configuration key the plugin really has must
 * appear in both READMEs, and every key the READMEs advertise must exist. A
 * README that quietly lists a renamed key is worse than no README.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Config } from "../index.js";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");
const readme = (name) => readFileSync(join(root, name), "utf8");

/** Rows of the "| `key` | `default` | ..." table. */
function documentedKeys(text) {
  const keys = new Set();
  for (const line of text.split("\n")) {
    const match = /^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|/.exec(line.trim());
    if (match) keys.add(match[1]);
  }
  return keys;
}

test("every config key is documented in both READMEs", () => {
  const declared = Object.keys(Config.dict ?? {});
  assert.ok(declared.length >= 7, `expected the seven config keys, saw ${declared.length}`);
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const documented = documentedKeys(readme(name));
    const missing = declared.filter((key) => !documented.has(key));
    assert.deepEqual(missing, [], `${name} is missing: ${missing.join(", ")}`);
  }
});

test("the READMEs document no key the schema does not have", () => {
  const declared = new Set(Object.keys(Config.dict ?? {}));
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const extra = [...documentedKeys(readme(name))].filter((key) => !declared.has(key));
    // The outcomes/limits tables use backticked identifiers too; only fail on
    // names that look like config keys (lowerCamelCase) and are unknown.
    const unknown = extra.filter((key) => /^[a-z][A-Za-z0-9]*$/.test(key) && key !== "k");
    assert.deepEqual(unknown, [], `${name} documents unknown keys: ${unknown.join(", ")}`);
  }
});

test("every field the settings card renders has a hint in both locales", () => {
  // The card shows a curated list, not every config key: a key that only appears in
  // a profile patch has no control, so demanding a label for it would be noise.
  const source = readFileSync(join(root, "client.js"), "utf8");
  const declared = new Set(Object.keys(Config.dict ?? {}));
  // "field.invalidRange" is a sentence, not a control, so intersect with the schema.
  const rendered = [...new Set([...source.matchAll(/"field\.([A-Za-z][A-Za-z0-9]*)":/g)].map((m) => m[1]))].filter((key) =>
    declared.has(key),
  );
  assert.ok(rendered.length >= 7, `expected the card's field list, saw ${rendered.length}`);
  const missing = rendered.filter((key) => source.split('"hint.' + key + '"').length - 1 < 2);
  assert.deepEqual(missing, [], `client.js renders a field without a hint in both locales: ${missing.join(", ")}`);
});

test("the settings card renders a control for every configuration key", () => {
  // A key that exists in the schema but not on the card can only be changed by
  // editing the profile by hand, which is exactly what users asked us to fix.
  const source = readFileSync(join(root, "client.js"), "utf8");
  const start = source.indexOf("const FIELDS = [");
  const end = source.indexOf("\n    ];", start);
  const block = source.slice(start, end);
  const shown = new Set([...block.matchAll(/\{ key: "([A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1]));
  const declared = Object.keys(Config.dict ?? {});
  const missing = declared.filter((key) => !shown.has(key));
  assert.deepEqual(missing, [], `the settings card has no control for: ${missing.join(", ")}`);
});

test("both READMEs cross-link and the English one carries no Chinese prose", () => {
  const en = readme("README.md");
  const zh = readme("README.zh-CN.md");
  assert.match(en, /\[English \| 简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(zh, /\[English\]\(README\.md\) \| 简体中文/);
  // Only the language-toggle line may contain CJK characters in the main file.
  const offenders = en
    .split("\n")
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => /[\u4e00-\u9fff]/.test(line))
    .filter(({ line }) => !line.includes("README.zh-CN.md"));
  assert.deepEqual(offenders.map((item) => item.index), [], "the English README must stay English");
});
