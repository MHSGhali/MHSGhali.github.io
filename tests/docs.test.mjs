/* What keeps docs/ from quietly going stale.

   Documentation nothing checks is documentation that rots, and it rots in a
   way nobody notices until someone follows it and finds a file that has not
   existed for six months. The rest of this suite pins behaviour to numbers;
   this file pins prose to the tree it describes.

   Be honest about what that can and cannot do. These tests check STRUCTURE:
   that every path the docs name still exists, that every page and every
   subsystem is claimed by a doc, that no doc quotes a version stamp the build
   script will never refresh. They cannot check whether `optics.md` still
   describes the optics engine correctly, which is where documentation drift
   actually happens. Passing here means the docs are not obviously wrong, not
   that they are right. When you change how something works, the doc that
   claims to explain it is part of the change.

   Paths resolve from this file rather than from the working directory. Every
   other test file assumes the cwd is the repo root and gets away with it on
   one or two reads; this one reads a dozen files and a directory listing, and
   is the test most likely to be run from inside docs/ by someone working
   there. Under a cwd assumption that failure reads as "the docs are missing"
   and sends them hunting a bug that is not there. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, globSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const there = (rel) => existsSync(join(ROOT, rel));

const DOCS = readdirSync(join(ROOT, "docs"))
  .filter((n) => n.endsWith(".md"))
  .sort();
const PROSE = ["CLAUDE.md", "README.md", ...DOCS.map((n) => `docs/${n}`)];

/* The index's file map: every non-blank line inside the first fenced block of
   docs/README.md, as [doc, what it covers]. Same shape as the directory map at
   the top of the repo README, which is where the idiom comes from. */
function indexMap() {
  const fence = /```\n([\s\S]*?)```/.exec(read("docs/README.md"));
  assert.ok(fence, "docs/README.md has lost its fenced file map");
  return fence[1]
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const m = /^(\S+\.md)\s+(.*)$/.exec(line.trim());
      assert.ok(m, `the index row "${line.trim()}" is not "<name>.md  <paths>"`);
      return [m[1], m[2]];
    });
}

/* Paths a document names, in backticks, in a link, or bare in a table.

   Anchored on the top-level directories this repo actually has, plus a fixed
   set of root files. That whitelist is what makes this safe: `--check`,
   `parse()`, `?v=` and a bare `solver.worker.js` do not match it and are
   ignored, and so is `tests/test_mechanism.c` in the C repo, because .c is not
   one of the extensions below and this repo has no C in it. */
const ROOTS = "js|css|pages|partials|assets|scripts|tests|docs";
const ROOT_FILES = new Set([
  "index.html", "sw.js", "robots.txt", "sitemap.xml", "README.md",
  "CLAUDE.md", ".nojekyll", ".gitignore",
]);
const PATH_RE = new RegExp(`(?:^|[\\s\`("'\\[|])((?:${ROOTS})/[A-Za-z0-9_.*/-]*)`, "g");
const KNOWN_EXT = /\.(?:js|mjs|css|html|md|py)$/;

function pathsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(PATH_RE)) {
    const token = m[1].replace(/[.,;:)\]]+$/, "").replace(/\?v=[0-9a-f]{8}/, "");
    if (token.endsWith("/") || KNOWN_EXT.test(token)) out.add(token);
  }
  /* Root files have no directory to anchor on, so they are matched by name at
     a word boundary, backticked or bare. Every name in the set exists, so the
     looseness here can only ever add a token that passes, never invent one
     that fails. */
  for (const name of ROOT_FILES) {
    const re = new RegExp(`(?:^|[\\s\`("'\\[|])${name.replace(/\./g, "\\.")}(?![\\w.-])`, "m");
    if (re.test(text)) out.add(name);
  }
  return out;
}

const exists = (token) => (token.includes("*")
  ? globSync(token, { cwd: ROOT }).length > 0
  : there(token));

/* ------------------------------------------------------------------ index */

test("the docs folder and its index list the same files", () => {
  const listed = indexMap().map(([doc]) => doc).sort();
  const present = DOCS.filter((n) => n !== "README.md").sort();
  assert.deepEqual(listed, present,
    "docs/README.md's map and the contents of docs/ have diverged");
});

test("the entry points point at the docs folder", () => {
  for (const file of ["CLAUDE.md", "README.md"]) {
    assert.ok(read(file).includes("docs/README.md"),
      `${file} never sends the reader to docs/README.md`);
  }
});

/* --------------------------------------------------------------- coverage */

test("every page and every js subsystem is covered by a doc", () => {
  const covered = indexMap().map(([, what]) => what).join(" ");
  const claims = pathsIn(covered);

  const pages = ["index.html",
    ...readdirSync(join(ROOT, "pages")).filter((n) => n.endsWith(".html"))
      .map((n) => `pages/${n}`)];
  for (const page of pages) {
    assert.ok(claims.has(page), `no doc in docs/README.md claims ${page}`);
  }

  /* Subsystems are claimed as directories, so adding a file to one of them
     changes nothing here. A new top-level script IS a new subsystem and is
     meant to fail until it is written down. */
  for (const name of readdirSync(join(ROOT, "js"), { withFileTypes: true })) {
    const token = name.isDirectory() ? `js/${name.name}/` : `js/${name.name}`;
    assert.ok(claims.has(token), `no doc in docs/README.md claims ${token}`);
  }
});

/* ------------------------------------------------------------------ drift */

test("every path the docs name is a file that exists", () => {
  for (const file of PROSE) {
    for (const token of pathsIn(read(file))) {
      assert.ok(exists(token), `${file} names ${token}, which does not exist`);
    }
  }
});

test("no doc quotes a version stamp", () => {
  /* scripts/build-site.py versions .css and .js and nothing else, so a real
     ?v= hash pasted into markdown is wrong after the next deploy and stays
     wrong forever, with nothing to correct it. */
  for (const file of PROSE) {
    const stamp = /\?v=[0-9a-f]{8}/.exec(read(file));
    assert.equal(stamp, null,
      `${file} quotes ${stamp && stamp[0]}, which nothing will ever refresh`);
  }
});

/* ---------------------------------------------------------- the contract */

test("CLAUDE.md and the README give the same build and test commands", () => {
  for (const command of ["python3 scripts/build-site.py",
                         "python3 scripts/build-site.py --check",
                         "node --test tests/*.mjs"]) {
    for (const file of ["CLAUDE.md", "README.md"]) {
      assert.ok(read(file).includes(command), `${file} has lost "${command}"`);
    }
  }
});

test("the commands CLAUDE.md promises are ones this repo can run", () => {
  /* Without this the test above is two documents agreeing with each other and
     both being wrong. This is the one that anchors them to the tree. */
  assert.ok(readdirSync(join(ROOT, "tests")).some((n) => n.endsWith(".mjs")),
    "node --test tests/*.mjs would match nothing");
  assert.ok(read("scripts/build-site.py").includes('"--check" in sys.argv'),
    "build-site.py no longer takes --check, but the docs still promise it");
});

/* ------------------------------------------------------------ conventions */

test("no markdown carries an em dash", () => {
  /* The site's prose convention, and markdown is the first place in this repo
     where prose is typed directly rather than through HTML, so it is the first
     place a literal one can appear. ASCII "--" stays allowed: it is what the
     README and every source comment use, and it is half of "--check". */
  for (const file of PROSE) {
    const hit = /\u2014/.exec(read(file));
    assert.equal(hit, null,
      `${file} has an em dash; use a comma, a colon, "--", or write U+2014`);
  }
});

test("the docs stay out of what the site serves", () => {
  /* docs/ is repo documentation, not a page. .nojekyll means a linked .md
     would be served to a visitor as raw text. */
  const served = ["sitemap.xml", "index.html",
    ...readdirSync(join(ROOT, "pages")).map((n) => `pages/${n}`),
    ...readdirSync(join(ROOT, "partials")).map((n) => `partials/${n}`)];
  for (const file of served) {
    assert.ok(!read(file).includes("docs/"), `${file} links into docs/`);
  }
});
