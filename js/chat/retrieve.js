/* ---------------------------------------------------------------
   Sending only the part of a document that a question is about.

   These models run a 4096-token window and WebLLM keeps no prefix cache, so
   the whole system prompt is prefilled again on every single message. A long
   document in the prompt is therefore paid for twice over: once in the room it
   leaves for the conversation, and once in the wait before every answer.

   So a document is cut into sections and only the ones a question touches are
   sent, on top of a core that is always present. Term overlap with inverse
   document frequency, which is enough when the corpus is a dozen paragraphs
   and costs no download and no second model.

   This was written for the résumé in profile.js and is now shared with the two
   simulator knowledge documents, which are cut on their XML tags rather than
   on Markdown headings -- hence `split` and `titleOf` being arguments.
   --------------------------------------------------------------- */

const words = (s) => s.toLowerCase().replace(/[^a-z0-9+]+/g, " ").split(/\s+/).filter(Boolean);

/* makeRetriever({...}) -> { head, sections, select(question, budget) }

   text     the whole document
   split    where a section begins, as a lookahead regex
   titleOf  a section's title, taken from its own first line
   core     titles always sent, whatever the question
   flat     words too common in THIS document to point anywhere
   nudges   [regex, title] pairs, for a section whose subject a question can
            name without using any of its words
   budget   characters of document per request
*/
export function makeRetriever({ text, split, titleOf, core = [], flat = "", nudges = [], budget = 4000 }) {
  const parts = String(text).split(split);
  const head = parts[0];
  const sections = parts.slice(1).map((body) => ({ title: titleOf(body), text: body }));

  const FLAT = new Set(words(flat));

  /* How many sections each term appears in. A term in one section points at
     that section; a term in six points nowhere. */
  const spread = new Map();
  for (const s of sections) {
    for (const w of new Set(words(s.text))) spread.set(w, (spread.get(w) || 0) + 1);
  }
  const weight = (t) => {
    const n = spread.get(t) || 0;
    return n === 0 ? 0 : n === 1 ? 3 : n === 2 ? 2 : 1;
  };

  const score = (section, terms) => {
    const hay = new Set(words(section.text));
    let hits = 0;
    for (const t of terms) if (hay.has(t)) hits += weight(t);
    return hits;
  };

  function select(question, limit = budget) {
    const terms = [...new Set(words(question || ""))].filter((w) => w.length >= 4 && !FLAT.has(w));

    const forced = new Set(core);
    for (const [re, title] of nudges) if (re.test(String(question || ""))) forced.add(title);

    const ranked = sections
      .map((s, i) => ({ s, i, hit: forced.has(s.title) ? Infinity : score(s, terms) }))
      .filter((r) => r.hit > 0)
      .sort((a, b) => b.hit - a.hit || a.i - b.i);

    /* Keep whatever scored best, plus anything close to it. A fixed floor
       would throw away the only evidence there is when a question's one
       distinctive word happens to appear in three sections. */
    const top = ranked.reduce((m, r) => Math.max(m, r.hit === Infinity ? 0 : r.hit), 0);
    const floor = Math.max(Math.min(top, 3), top / 2);

    const chosen = [];
    let used = head.length;
    for (const r of ranked) {
      if (r.hit !== Infinity && r.hit < floor) continue;
      /* A forced section is one a nudge named outright, so the budget must not
         quietly drop it: "how fast is the motor" nudges both the rules and the
         numbers, and losing the numbers to a byte count is exactly the answer
         going missing. Scored sections still yield to the budget. */
      if (r.hit !== Infinity && used + r.s.text.length > limit && chosen.length) continue;
      chosen.push(r);
      used += r.s.text.length;
    }
    /* Nothing matched at all: a vague opener still deserves the section after
       the core rather than only the core. */
    if (chosen.length <= core.length && sections[1] && !chosen.some((r) => r.i === 1)) {
      chosen.push({ s: sections[1], i: 1 });
    }
    chosen.sort((a, b) => a.i - b.i);
    return [head, ...chosen.map((r) => r.s.text)].join("\n");
  }

  return { head, sections, select };
}

/* Cut on a Markdown heading, as the résumé is written. */
export const MARKDOWN = {
  split: /\n(?=## )/,
  titleOf: (body) => body.slice(3, body.indexOf("\n")),
};

/* Cut on an XML tag at the start of a line, as the knowledge documents are. */
export const CHEVRON = {
  split: /\n(?=<[a-z]+>)/,
  titleOf: (body) => body.slice(1, body.indexOf(">")),
};
