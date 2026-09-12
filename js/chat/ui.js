/* ---------------------------------------------------------------
   The chat itself, mountable three times over: as the whole of the Ask page,
   and as a panel on each simulator. One module, because the only thing that
   differs between them is which controller is plugged in and how much chrome
   is worth showing.

   The order a message is handled in matters, and it goes:

     1. the command grammar   -- exact, instant, never touches the GPU
     2. the topic gate        -- deterministic refusals, also free
     3. the model             -- prose, streamed, on the visitor's own hardware

   Which means the simulator answers commands before the model has finished
   downloading, and an off-topic question is refused without spending a token
   on it.
   --------------------------------------------------------------- */

import { systemPrompt, toolPrompt, selectContext, triage, REFUSALS, SUGGESTIONS, TOOL_HELP } from "./profile.js?v=58764426";
import { parse } from "./commands.js?v=58764426";
import { planSystem, planRequest, validatePlan, repairPlan, looksLikeABuild } from "./plan.js?v=58764426";
import * as engine from "./engine.js?v=58764426";
import { render, streamInto, attachCopy, stripPreamble, stripRefusalTail, TRY, stripTry } from "./render.js?v=58764426";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

/* WebLLM rebuilds the conversation from `messages` on every call and prefills
   all of it, so an unbounded history makes each answer slower than the last and
   eventually throws ContextWindowSizeExceededError, which breaks the chat for
   good. Budget in characters, roughly four per token, against a 4096 window. */
const CTX_CHARS = 4096 * 4;
const RESERVE_CHARS = 240 * 4 + 1200;   /* max_tokens plus slack */

/* One transcript for the whole visit, shared by all three mounts, so a question
   asked on the chat page is still there when you arrive at the linkage page.
   sessionStorage rather than localStorage: nothing about what a visitor asked
   should outlive the tab. */
const STORE_KEY = "chat-turns-v1";

function loadTurns() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
    if (Array.isArray(parsed)) {
      return parsed.filter((t) => t && typeof t.content === "string"
        && (t.role === "user" || t.role === "assistant"));
    }
  } catch (e) { /* malformed or unavailable: start empty */ }
  return [];
}

function saveTurns(turns) {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(turns.slice(-20))); }
  catch (e) { /* private mode or full quota: the chat still works, just not across pages */ }
}

export function mountChat(host, { mode = "page", controller } = {}) {
  const domain = controller?.domain || "links";
  /* Handed over by the controller rather than imported, so this module never
     depends on js/linkage/ or js/light/. */
  const knowledge = controller?.knowledge || null;
  let turns = loadTurns();
  let ready = false;         /* the model can actually answer */
  let generating = false;
  let stopped = false;
  let booting = false;

  /* ------------------------------------------------------------ the DOM */

  host.classList.add("chat");
  host.dataset.mode = mode;

  const gate = el("div", "chat-gate");
  const loader = el("div", "chat-loader");
  loader.hidden = true;
  const bar = el("i");
  const track = el("div", "chat-track");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", "0");
  track.setAttribute("aria-label", "Model download progress");
  track.appendChild(bar);
  const loaderMsg = el("p", "chat-loader-msg", "Starting up…");
  loader.append(track, loaderMsg);

  const log = el("div", "chat-log");
  log.setAttribute("aria-live", "polite");
  log.setAttribute("aria-atomic", "false");
  const chips = el("div", "chat-chips");
  const input = el("textarea");
  input.rows = 1;
  input.id = "chat-input-" + mode;
  input.placeholder = domain === "links"
    ? "Ask about his experience, projects, or the tools…"
    : "Ask, or tell me what to do with the simulator…";
  const label = el("label", "sr-only", "Your message");
  label.htmlFor = input.id;
  const send = el("button", "btn btn-primary", "Send");
  send.type = "submit";
  const stop = el("button", "btn", "Stop");
  stop.type = "button";
  stop.hidden = true;
  const form = el("form", "chat-composer");
  form.append(label, input, send, stop);
  const status = el("p", "chat-status", "Ready for commands");
  const clear = el("button", "linkish", "Clear");
  clear.type = "button";
  clear.hidden = true;
  const foot = el("div", "chat-foot");
  foot.append(status, clear);

  const body = el("div", "chat-body");
  body.append(log, chips, form, foot);

  host.append(gate, loader, body);

  /* --------------------------------------------------------- transcript */

  function addMessage(role, text) {
    const wrap = el("div", "chat-msg chat-msg-" + role);
    const inner = el("div", "chat-msg-body");
    if (text) inner.appendChild(render(text));
    wrap.appendChild(inner);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return inner;
  }

  const setStatus = (t) => { status.textContent = t; };

  /* Replay whatever this visit already said, on every mount, so the panel on
     the linkage page opens onto the conversation from the chat page. */
  for (const t of turns) {
    const b = addMessage(t.role, t.content);
    if (t.role === "assistant") attachCopy(b.parentElement, () => t.content);
  }
  clear.hidden = turns.length === 0;

  function remember(role, content) {
    turns.push({ role, content });
    saveTurns(turns);
  }

  /* ------------------------------------------------------------ the gate */

  const SIZE_NOTE = "about 1.4 GB the first time";

  function buildGate() {
    gate.replaceChildren();
    if (mode === "page") {
      gate.append(
        el("h2", null, "One download, then it is local forever."),
        el("p", null,
          "The weights are " + SIZE_NOTE + ". They stream from a CDN once and stay in this "
          + "browser's cache, so every later visit starts in seconds. It needs WebGPU and about "
          + "2 GB of GPU memory; on a machine that cannot manage that it steps down to a smaller "
          + "model by itself. Integrated graphics are fine. Phones are the awkward case, since "
          + "they have to fetch and hold the same weights."),
      );
      const specs = el("div", "chat-specs");
      for (const [a, b] of [["Qwen3.5 2B", "4-bit quantized"], ["WebGPU", "your hardware"],
                            ["0 bytes", "sent to any server"]]) {
        const s = el("div", "chat-spec");
        s.append(el("b", null, a), el("span", null, b));
        specs.appendChild(s);
      }
      gate.appendChild(specs);
    } else {
      gate.append(el("p", null,
        "I can drive this simulator right now, no model needed: try “"
        + ({ light: "load the workcell", optics: "stop down to f/16" }[domain] || "load the Hoeken")
        + "”. For questions in prose, load the "
        + "language model into your browser (" + SIZE_NOTE + ")."));
    }
    const start = el("button", "btn btn-primary", "Load the model");
    start.type = "button";
    start.addEventListener("click", () => boot());
    gate.appendChild(start);
    const note = el("p", "chat-gate-note",
      "A minute or so on a fast connection. Instant on every visit after that, and it stays "
      + "loaded while you move around the site.");
    gate.appendChild(note);

    /* If the weights are already here, the warning above is just noise. */
    engine.cachedAlready().then((yes) => {
      if (yes) note.textContent = "Already downloaded on this device, so this takes a few seconds.";
    });
  }

  function failGate(title, detail) {
    ready = false;
    booting = false;
    gate.hidden = false;
    loader.hidden = true;
    gate.replaceChildren(el("h2", null, title), el("p", null, detail));
    const row = el("div", "hero-cta");
    const resume = el("a", "btn btn-primary", "Download the resume instead");
    resume.href = new URL("../../assets/files/MarkGerges.pdf", import.meta.url).pathname;
    const li = el("a", "btn", "LinkedIn");
    li.href = "https://www.linkedin.com/in/mark-gerges-9899967a/";
    li.target = "_blank";
    li.rel = "noopener";
    row.append(resume, li);
    gate.appendChild(row);
    if (domain !== "links") {
      gate.appendChild(el("p", "chat-gate-note",
        "The simulator commands below still work: they never needed the model."));
    }
    setStatus("Model unavailable");
  }

  buildGate();

  /* ------------------------------------------------------------- loading */

  async function boot() {
    if (booting || ready) return;
    booting = true;
    const problem = await engine.webgpuProblem();
    if (problem) { failGate(problem.title, problem.detail); return; }

    gate.hidden = true;
    loader.hidden = false;
    setStatus("Loading the model");
    const t0 = performance.now();

    try {
      await engine.loadEngine({
        onStage: (t) => { loaderMsg.textContent = t; },
        onProgress: (report) => {
          const pct = Math.max(0, Math.min(1, report.progress || 0));
          bar.style.width = (pct * 100).toFixed(1) + "%";
          track.setAttribute("aria-valuenow", String(Math.round(pct * 100)));
          const mb = /(\d+)MB/.exec(report.text || "");
          /* Download speed is set by the link, not by anything here: WebLLM
             already fetches on four parallel streams and throughput plateaus
             there. So show the rate and what is left rather than leaving a bar
             creeping for a minute with no explanation. */
          let detail = "";
          if (mb && pct > 0.02) {
            const secs = (performance.now() - t0) / 1000;
            detail = ` · ${(Number(mb[1]) / secs).toFixed(1)} MB/s · about ${Math.max(0, Math.round(secs / pct - secs))}s left`;
          }
          loaderMsg.textContent = report.text?.includes("Loading model from cache")
            ? "Loading from cache…"
            : mb ? `${mb[1]} MB downloaded · ${Math.round(pct * 100)}%${detail}`
                 : (report.text || "Preparing…").replace(/ It can take a while.*$/, "");
        },
      });
    } catch (err) {
      failGate("The model failed to load.",
        "Something went wrong fetching or compiling the weights: "
        + (err?.message || err) + ". A reload often fixes it.");
      return;
    }

    loaderMsg.textContent = "Warming up…";
    /* Warm up on the shape this page will actually send. On a simulator the
       first real question is a tool question, and warming the resume prompt
       instead leaves the visitor paying the shader compilation this exists to
       hide. */
    await engine.warmUp(knowledge
      ? toolPrompt({
          knowledge: knowledge.selectKnowledge("what can this do"),
          state: controller?.stateBlock?.() || "",
        })
      : systemPrompt(domain, selectContext("what does Mark do at Tesla")));

    loader.hidden = true;
    booting = false;
    ready = true;
    setStatus(engine.currentModel().replace(/-MLC$/, "") + " · running on your GPU");
    input.focus();
    if (pendingQuestion) {
      const q = pendingQuestion;
      pendingQuestion = null;
      route(q);
    }
  }

  /* A question typed before the model was loaded, held until it is. */
  let pendingQuestion = null;

  /* An offer to load, shown inline in the transcript rather than as a modal:
     downloading a gigabyte is the visitor's decision, so it is never started
     for them. */
  function offerLoad(question) {
    const b = addMessage("assistant", "");
    /* The wording lives in its own element rather than in the message body,
       because the cache check below resolves after the button is appended and
       replacing the body's children would take the button with it. */
    const text = el("div");
    text.appendChild(render("That one needs the language model, which is not loaded yet. "
      + "It downloads once, " + SIZE_NOTE + ", and runs entirely on your machine."));
    b.appendChild(text);
    /* A returning visitor already has the weights, and quoting them a gigabyte
       and a half to answer one question is a good reason not to bother. */
    engine.cachedAlready().then((yes) => {
      if (yes) text.replaceChildren(render("That one needs the language model. It is already "
        + "downloaded on this device, so starting it takes a few seconds, and it then runs "
        + "entirely on your machine."));
    });
    const btn = el("button", "btn btn-primary chat-inline-btn", "Load the model and answer");
    btn.type = "button";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Loading…";
      pendingQuestion = question;
      await boot();
      /* The offer has been taken and the answer is on its way, so the button
         has no job left. Without this it sat in the transcript reading
         "Loading…" underneath the finished answer. */
      btn.remove();
    });
    b.appendChild(btn);
  }

  /* ------------------------------------------------------------ commands */

  function runCommands(cmds, fixes = []) {
    const said = [];
    for (const cmd of cmds) {
      if (cmd.action === "help") { said.push(controller?.help?.() || TOOL_HELP.links); continue; }
      /* A controller reaches into a live simulator, so one that throws must not
         take the reply with it: without this, a bug in an action left the
         visitor's message on screen with no answer at all and nothing to say
         why. Report it and carry on with the rest of the sentence. */
      try {
        const out = cmd.action === "describe"
          ? (controller?.describe?.() || "There is no simulator on this page to look at.")
          : controller?.apply?.(cmd);
        /* A controller may answer with a bare string, or with a string and the
           command that would fix what it just refused. */
        if (out && typeof out === "object") {
          if (out.text) said.push(out.text);
          if (out.suggest) fixes.push(out.suggest);
        } else if (out) said.push(out);
      } catch (err) {
        console.error(`the ${cmd.action} command failed`, err);
        said.push(`That went wrong on my side: ${err?.message || err}. `
          + "The simulator is still yours to drive by hand.");
      }
    }
    return said;
  }

  /* --------------------------------------------------------- the model */

  function buildMessages(question, verdict) {
    /* Either the tool's own documentation and live state, or the resume, never
       both: sending both would roughly double the prompt, and WebLLM prefills
       the whole thing on every message, so it would cost a wait on every turn
       for the privilege of answering one of the two questions badly.

       The state block goes in the system message and nowhere else. It must not
       reach `turns`, or a mechanism's coordinates would follow the visitor to
       another page and be quoted back at them as though still true. */
    let system;
    if (verdict?.subject === "tool" && knowledge) {
      const state = controller?.stateBlock?.() || "";
      system = toolPrompt({ knowledge: knowledge.selectKnowledge(question), state });
    } else {
      system = systemPrompt(domain, selectContext(question));
    }
    const budget = CTX_CHARS - system.length - RESERVE_CHARS;
    const kept = [];
    let used = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      const size = turns[i].content.length;
      if (used + size > budget && kept.length) break;
      kept.unshift(turns[i]);
      used += size;
    }
    /* A window must never open on an assistant reply with no question in front
       of it, which is what dropping from the front can leave behind. */
    while (kept.length && kept[0].role === "assistant") kept.shift();
    return [{ role: "system", content: system }, ...kept];
  }

  async function answerWithModel(question, verdict) {
    if (generating) return;
    generating = true;
    stopped = false;
    send.hidden = true;
    stop.hidden = false;

    /* The question joins the transcript BEFORE the request is built, because
       buildMessages() sends the transcript: leaving it until after would send a
       conversation whose last turn is the previous answer, which WebLLM rejects
       outright with MessageOrderError. */
    remember("user", question);
    const messages = buildMessages(question, verdict);

    const out = addMessage("assistant", "");
    out.classList.add("chat-thinking");
    out.setAttribute("aria-busy", "true");
    const sink = streamInto(out, log);
    let answer = "";
    const t0 = performance.now();
    let first = null;
    const tick = setInterval(() => {
      if (first === null) setStatus(`Thinking… ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    }, 500);

    try {
      for await (const chunk of engine.stream(messages)) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          if (first === null) { first = performance.now() - t0; clearInterval(tick); }
          answer += delta;
          out.classList.remove("chat-thinking");
          sink.update(stripTry(stripPreamble(engine.stripThink(answer).trimStart())));
        }
        if (chunk.usage) {
          const secs = (performance.now() - t0) / 1000;
          setStatus(`${chunk.usage.completion_tokens} tokens · `
            + `${(chunk.usage.completion_tokens / secs).toFixed(1)} tok/s · on your GPU`);
        }
      }

      /* A stop that produced text is a real, partial answer and is kept. With
         no text at all there is nothing worth remembering, so the user turn
         goes too: an empty assistant message would sit in every later request
         and desync what the model sees from what is on screen. */
      const whole = stripPreamble(engine.stripThink(answer).trim());
      /* The model may end an answer with the one command that would fix what it
         just explained. It is a suggestion, not an action: offerFix re-parses it
         and drops it if the grammar does not accept it. Stripped from the text
         either way, so it is neither shown as literal angle brackets nor
         remembered into the conversation. */
      const suggested = (TRY.exec(whole) || [])[1];
      const clean = stripRefusalTail(stripTry(whole));
      sink.finish(clean || "");
      out.removeAttribute("aria-busy");
      if (clean) {
        remember("assistant", clean);
        attachCopy(out.parentElement, () => clean);
        if (suggested) offerFix(suggested.trim(), out);
      } else {
        out.classList.remove("chat-thinking");
        out.replaceChildren(render(stopped
          ? "Stopped before it got going."
          : "I did not manage an answer to that one. Try rephrasing?"));
        turns.pop();
        saveTurns(turns);
      }
    } catch (err) {
      console.error(err);
      out.classList.remove("chat-thinking");
      out.replaceChildren(render(err?.name === "ContextWindowSizeExceededError"
        ? "This conversation outgrew the model's context. Older turns were dropped, ask again."
        : "Something went wrong generating that answer. Try again?"));
      turns.pop();
      saveTurns(turns);
    } finally {
      clearInterval(tick);
      generating = false;
      send.hidden = false;
      stop.hidden = true;
      clear.hidden = turns.length === 0;
      chips.hidden = false;
      input.focus();
    }
  }

  /* --------------------------------------------------------- fix chips

     A refusal that knows the remedy offers it as a button. Three gates stand
     between a suggestion and the simulator, and it needs all three:

       1. it is AUTHORED by the controller, which computed the diagnosis from
          live state, or by the model inside <try> tags;
       2. it is only rendered if parse() accepts it here;
       3. tapping it calls ask(), so it is parsed again and every precondition
          is re-checked at the moment it runs.

     The third gate is what makes a stale chip harmless: a suggestion that made
     sense two turns ago and does not now simply produces the same helpful
     refusal again rather than doing the wrong thing.

     Never rendered in the transcript replay, only on a live reply. A chip
     restored from another page's conversation would be a live wrong button. */
  function offerFix(say, body) {
    if (!say || !parse(say, domain).length) return;
    const row = el("div", "chat-chips chat-fixes");
    const b = el("button", "chat-chip chat-fix", say);
    b.type = "button";
    b.addEventListener("click", () => { row.remove(); ask(say); });
    row.appendChild(b);
    body.appendChild(row);
  }

  /* --------------------------------------------------------- the planner

     One sentence in, a whole mechanism out. The model writes the steps and the
     grammar executes them, which means a plan can be wrong about geometry but
     never about what an action IS: a line that does not parse is dropped
     before anything happens, and every line that does parse is the same
     command the visitor could have typed.

     The steps are run a frame apart so the build is watchable rather than
     appearing all at once. On a mechanism that is the difference between
     seeing it assembled and finding it assembled. */
  async function buildFromPlan(question) {
    if (generating) return;
    generating = true;
    send.hidden = true;
    stop.hidden = false;
    stopped = false;

    const out = addMessage("assistant", "");
    out.classList.add("chat-thinking");
    setStatus("Working out the steps…");

    /* One try around the whole thing, and the controls restored in `finally`.
       An exception anywhere in here used to leave the composer disabled and a
       blank bubble on screen with no way back except a reload: whatever goes
       wrong, the visitor gets their Send button back. */
    try {
      let text = "";
      /* System for the instructions, user for the request. The visitor's words
         never sit inside the rules. */
      const messages = [
        { role: "system", content: planSystem(knowledge) },
        { role: "user", content: planRequest(question) },
      ];
      for await (const chunk of engine.stream(messages, { maxTokens: 340 })) {
        text += chunk.choices?.[0]?.delta?.content || "";
      }

      const { steps: written, dropped } = validatePlan(engine.stripThink(text), domain);
      const steps = repairPlan(written, question, domain);
      out.classList.remove("chat-thinking");

      if (!steps.length) {
        out.replaceChildren(render("I could not turn that into steps I am allowed to run. "
          + (controller?.help?.() || "")));
        return;
      }

      out.replaceChildren(render(`Here is the plan, ${steps.length} step${steps.length === 1 ? "" : "s"}:\n`
        + steps.map((s) => "- " + s.line + (s.repaired ? " (added, you asked for it to move)" : "")).join("\n")));

      const results = [];
      for (const step of steps) {
        if (stopped) break;
        const said = runCommands(step.cmds);
        if (said.length) results.push(said.join(" "));
        /* A frame between steps, so the canvas repaints and the build is
           something you watch rather than something you find. Only when there
           is someone to watch it: a hidden tab throttles BOTH rAF and timers,
           which turned a one second build into a ten minute one that looked
           for all the world like a hang. */
        if (!document.hidden) {
          await new Promise((r) => { requestAnimationFrame(r); setTimeout(r, 80); });
        }
      }

      /* What you ended up WITH, not what the last step happened to say. Ten
         steps reported as "Set it to 400 lm" is a report on the tenth step and
         tells you nothing about the thing that was built. */
      let ended = "";
      try { ended = controller?.describe?.() || ""; } catch (e) { /* readback is a nicety */ }
      const summary = (stopped ? "Stopped part way. " : "")
        + (ended || (results.length ? results[results.length - 1] : "Nothing came of those steps."))
        + (dropped.length
          ? dropped.length === 1
            ? " I stopped there: the next line was not a command I can run."
            : ` I stopped there, ignoring ${dropped.length} lines that were not commands I can run.`
          : "");
      const tail = addMessage("assistant", summary);
      attachCopy(tail.parentElement, () => summary);

      remember("user", question);
      remember("assistant", `Built it in ${steps.length} steps. ` + summary);
      setStatus(`Ran ${steps.length} steps`);
    } catch (err) {
      console.error("the planner failed", err);
      out.classList.remove("chat-thinking");
      out.replaceChildren(render("I could not work out a plan for that one: "
        + (err?.message || err) + ". You can still build it a step at a time, "
        + "and I will do each one exactly."));
      setStatus("The plan failed");
    } finally {
      generating = false;
      send.hidden = false;
      stop.hidden = true;
      clear.hidden = turns.length === 0;
      chips.hidden = false;
      input.focus();
    }
  }

  /* ------------------------------------------------------------- routing */

  function ask(text) {
    const question = text.trim();
    if (!question || generating) return;
    input.value = "";
    input.style.height = "auto";
    chips.hidden = true;
    addMessage("user", question);
    route(question);
  }

  /* Everything after the message is on screen. Kept separate so a question held
     while the model downloaded comes back through the SAME routing, and a build
     request queued before the load still reaches the planner rather than being
     answered as prose. */
  function route(question) {
    /* 1. A request to BUILD a whole thing, which is the one case the grammar
       cannot express: "build me a crank that spins" names an outcome and no
       steps. Checked FIRST, because such a sentence usually contains a word
       the grammar would otherwise act on alone -- "on a motor" would fire the
       motor command by itself and the rest of the request would be lost. */
    if (controller?.apply && domain !== "links" && looksLikeABuild(question, domain)) {
      if (!ready) { wantModel(question); return; }
      buildFromPlan(question);
      return;
    }

    /* 2. A command is executed exactly, whether or not a model exists. */
    const cmds = parse(question, domain);
    if (cmds.length) {
      const fixes = [];
      const said = runCommands(cmds, fixes);
      if (said.length) {
        const reply = said.join(" ");
        const body = addMessage("assistant", reply);
        /* A refusal that knows the remedy offers it. Only the first: two
           buttons under one sentence is a menu, not a suggestion. */
        if (fixes.length) offerFix(fixes[0], body);
        remember("user", question);
        remember("assistant", reply);
        clear.hidden = false;
        chips.hidden = false;
        setStatus(ready ? engine.currentModel().replace(/-MLC$/, "") + " · running on your GPU"
                        : "Done, and the GPU was not needed");
        return;
      }
    }

    /* 3. Anything unrelated is refused here, before a token is spent on it.
       The same pass decides WHICH body of knowledge answers it, because the
       two decisions rest on the same evidence. */
    const verdict = triage(question, { domain, knowledge });
    if (verdict.kind !== "on-topic") {
      addMessage("assistant", REFUSALS[verdict.kind]);
      chips.hidden = false;
      setStatus(verdict.kind === "greeting" ? "Ready" : "Off topic, not sent to the model");
      return;
    }

    /* 4. Prose, which is the only thing left that needs the model. */
    if (!ready) { wantModel(question); return; }
    answerWithModel(question, verdict);
  }

  function wantModel(question) {
    if (booting) {
      pendingQuestion = question;
      setStatus("Queued. This sends as soon as the model finishes loading.");
      addMessage("assistant", "Holding that until the model finishes loading.");
    } else {
      offerLoad(question);
    }
  }

  /* ------------------------------------------------------------- wiring */

  form.addEventListener("submit", (e) => { e.preventDefault(); ask(input.value); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });
  stop.addEventListener("click", () => { stopped = true; engine.interrupt(); });
  clear.addEventListener("click", () => {
    turns = [];
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* nothing to remove */ }
    log.replaceChildren();
    chips.hidden = false;
    clear.hidden = true;
    setStatus("Cleared");
    input.focus();
  });

  for (const s of (SUGGESTIONS[domain === "links" ? "chat" : domain] || [])) {
    const b = el("button", "chat-chip", s);
    b.type = "button";
    b.addEventListener("click", () => ask(s));
    chips.appendChild(b);
  }

  /* The engine may already be up from another page in this visit, in which case
     there is nothing to gate and the panel should just be open. */
  if (engine.isLive()) {
    gate.hidden = true;
    ready = true;
    setStatus(engine.currentModel().replace(/-MLC$/, "") + " · running on your GPU");
  } else if (engine.wasLiveThisSession()) {
    /* Loaded earlier this visit, so it is in the service worker and in cache:
       picking it back up costs seconds, not a download. */
    boot();
  }

  return { ask, addMessage };
}
