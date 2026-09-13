# The assistant

`pages/chat.html` is the assistant on its own, and the same panel mounts on each
of the three simulator pages. There is no server behind any of it: a small
quantized language model is downloaded into the browser, compiled to WebGPU
shaders, and run on the visitor's own GPU. Nothing typed leaves the machine, and
once the weights are cached the whole thing works offline.

The single most important thing to understand before changing anything here: the
model is not what drives the simulators. It answers questions. A command is
matched against a closed grammar and executed exactly. Those are two separate
paths and the split is the whole design.

## The files

```
js/chat/page.js      the Ask page entry point; just the mount
js/chat/ui.js        the chat itself, mountable four times over
js/chat/engine.js    choosing a model, loading it, running a completion
js/chat/worker.js    the dedicated-worker fallback
js/chat/commands.js  visitor text to simulator commands: a closed grammar
js/chat/plan.js      building something in one sentence, re-parsed through the grammar
js/chat/profile.js   everything the model knows about Mark, and the topic gate
js/chat/retrieve.js  sending only the part of a document a question is about
js/chat/render.js    model output to DOM, escape-first, never innerHTML
js/chat/links.js     the Ask page controller, where a command becomes a link
sw.js                the service worker that keeps the model resident
```

`js/chat/` is the tool-agnostic half and must stay that way. It never imports a
simulator: the knowledge and the controller arrive from the page that mounts it.
`tests/knowledge.test.mjs` enforces this by reading every file in the directory
and failing on an import of `../linkage/`, `../light/` or `../optics/`.

## What happens to a message

Four steps, and only the last one costs a GPU.

1. **A plan request** (`js/chat/plan.js`), if the visitor asked for something to
   be built. The model writes lines in the same vocabulary a visitor would type,
   and every line goes back through `parse()`. A line that does not parse is
   dropped. So the model can propose anything and still cannot invent an action.
2. **The grammar** (`js/chat/commands.js`). A closed vocabulary, tested from both
   ends: that it fires on what people actually type, and that it stays quiet on
   questions that merely mention a mechanism by name. A command never reaches
   the model at all.
3. **The topic gate** (`triage()` in `js/chat/profile.js`). A 1B model will
   cheerfully answer "who wrote Don Quixote" and get it wrong, on Mark's site,
   under his name. Prompt rules alone do not hold at that size, so anything with
   no connection to the profile is refused deterministically, before any
   inference. It is both safer and instant.
4. **Prose**, which is the only step that reaches the GPU.

On the tool pages a parsed command presses the buttons through that page's
controller (`js/linkage/assistant.js` and its siblings). On the Ask page there
is nothing to drive, so `js/chat/links.js` turns the same request into a URL
that opens the right tool with the right thing already loaded.

## The model, and getting it resident

`js/chat/engine.js` owns all of this. No caller names a model.

- **A ladder of six candidates**, newest and best first, resolved at runtime
  against whatever the pinned WebLLM build actually ships, so bumping the CDN
  version cannot strand the site on an id that no longer exists. A phone starts
  three rungs down rather than spending a gigabyte of someone's data on a load
  that will not fit.
- **Two transports.** The service worker (`sw.js`) outlives a navigation, so the
  model stays resident when the visitor walks from the Ask page to a simulator.
  A dedicated worker is rebuilt on every page, which is the difference between
  an instant panel and a thirty second wait. The service worker is tried first
  and the dedicated worker is the fallback.
- **Persistent storage is requested**, because cache storage is best-effort by
  default and a browser under disk pressure can evict a gigabyte of weights.
- **A warm-up generation** runs on the real prompt so nobody pays shader
  compilation on their own first question.
- `sw.js` registers no fetch handler, on purpose. It exists only to host the
  WebLLM engine handler and never intercepts or caches ordinary requests.

## Context is the budget

The models run a 4096-token window and WebLLM keeps no prefix cache, so the
entire system prompt is prefilled again on every single message. Prompt length
is therefore a per-message cost, paid in the visitor's seconds, and almost every
design decision in this subsystem follows from that:

- `js/chat/retrieve.js` cuts a document into sections and sends only the ones a
  question touches, on top of a core that is always present. Term overlap with
  inverse section frequency, which is enough for a corpus of a dozen paragraphs
  and costs no download and no second model.
- The resume in `js/chat/profile.js` is split on `## ` headings; each tool's
  knowledge document is split on its own tags.
- A question about a simulator sends that tool's documentation or the resume,
  never both.
- The transcript is trimmed against the window before every request.
- `tests/chat.test.mjs` and `tests/knowledge.test.mjs` both assert the whole
  prompt stays under half the window. The optics page has the least headroom of
  the four, so check it after adding anything.

When you add a section to `PROFILE`, check what it steals. Retrieval weights a
term by how few sections contain it, so a new section that repeats a distinctive
word can pull questions away from the section that used to own them. The
`nudges` list exists for subjects a question can name without using any of a
section's own words, and a nudged section bypasses the byte budget by design.

## Safety

`js/chat/render.js` is escape-first and node-by-node: nothing the model writes
is ever assigned to `innerHTML`. A local model cannot be prompt-injected by a
remote page, but the visitor's own typing comes back through the transcript, so
the renderer is built as if the text were hostile.

The profile deliberately contains no email address and no phone number. The rest
of the site goes out of its way to keep the address out of the served bytes, and
a profile string in a static `.js` file is the easiest scrape on the site. The
model points people at the contact section instead.

## Keeping the prompts honest

A prompt is the easiest thing in this repo to get quietly wrong. Nothing crashes
when it promises a command the grammar has never heard of, or names a starter
renamed two commits ago. It just produces a confident wrong answer about a tool
the visitor is looking at. So `tests/knowledge.test.mjs` pins the claims to the
code that has to honour them: every command form the prompt offers is re-parsed
through the real grammar, every preset it names is checked against the real
preset tables, and the live state block is capped so a big mechanism cannot
crowd out the conversation.
