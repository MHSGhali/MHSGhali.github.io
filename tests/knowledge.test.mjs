/* What the assistant is told about each simulator, and what stops it drifting
   from what the simulator actually does.

   The knowledge documents are prompts, which makes them the easiest thing in
   this repo to get quietly wrong: nothing crashes when a prompt promises a
   command the grammar has never heard of, or names a starter that was renamed
   two commits ago. It just produces a confident wrong answer about a tool the
   visitor is looking at. So the claims are pinned to the code that has to
   honour them, and the caps that keep a live mechanism from crowding the
   context window are pinned to numbers.

   All of it runs under node, which is why the knowledge modules and the state
   formatters carry no DOM. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { parse, LINKAGE_PRESETS, LIGHT_PRESETS, OPTICS_PRESETS } from "../js/chat/commands.js";
import { triage, toolPrompt, systemPrompt, selectContext } from "../js/chat/profile.js";
import { planSystem } from "../js/chat/plan.js";
import * as linkage from "../js/linkage/knowledge.js";
import * as light from "../js/light/knowledge.js";
import * as optics from "../js/optics/knowledge.js";

const TOOLS = [["linkage", linkage], ["light", light], ["optics", optics]];

/* A vocabulary line is written with placeholders. Fill them with values a
   visitor would actually use. */
function fill(form) {
  return form
    .replace(/<x>/g, "-80").replace(/<y>/g, "40").replace(/<z>/g, "0.45")
    .replace(/<a>/g, "1").replace(/<b>/g, "2").replace(/<n>/g, "2")
    .replace(/<lumens>/g, "400").replace(/<kelvin>/g, "2700")
    .replace(/<degrees>/g, "25").replace(/<albedo>/g, "0.8")
    .replace(/<metres>/g, "0.05")
    .replace(/<focal>/g, "85").replace(/<fno>/g, "2.8")
    .replace(/<sensor>/g, "24").replace(/<pixels>/g, "480")
    .replace(/<exposure>/g, "40").replace(/<lux>/g, "5000");
}

/* ----------------------------------------------------- prompt against code */

test("every command the prompt offers is one the grammar accepts", () => {
  /* The load-bearing test. A form named here that parse() does not understand
     is a promise the assistant cannot keep: the planner writes it, validation
     silently drops it, and the step goes missing with no error anywhere. */
  for (const [domain, tool] of TOOLS) {
    for (const form of tool.VOCABULARY) {
      const said = fill(form);
      assert.ok(parse(said, domain).length, `${domain}: "${said}" (from "${form}") does not parse`);
    }
  }
});

test("every suggestion a refusal can offer is runnable", () => {
  /* These are the exact strings the controllers put on a fix chip. A chip that
     does not parse renders as nothing, so the visitor is told what to do and
     handed no way to do it. */
  const suggestions = {
    linkage: ["stop", "select all", "select link 1", "put a motor on it",
              "anchor joint 3", "unanchor joint 3"],
    light: ["select lamp 1"],
    optics: ["switch to the sky", "switch to the lamps"],
  };
  for (const [domain, says] of Object.entries(suggestions)) {
    for (const say of says) {
      assert.ok(parse(say, domain).length, `${domain}: the chip "${say}" would not run`);
    }
  }
  /* And anchoring is a toggle, so both wordings must reach the same action:
     offering "anchor joint 3" for an already anchored joint would say the
     opposite of what pressing it does. */
  assert.deepEqual(parse("unanchor joint 3", "linkage"), parse("anchor joint 3", "linkage"));
});

test("the capability list names every starter the tool ships", async () => {
  /* The help text prints without the model, so it is the one description a
     visitor is guaranteed to see, and it must not fall behind the menu. Checked
     against each TOOL's own preset list, which is what the menu shows, not
     against the grammar's matching aliases. */
  const distinctive = (name) =>
    name.toLowerCase().split(/[\s,]+/).sort((a, b) => b.length - a.length)[0];

  const mech = await import("../js/linkage/presets.js");
  for (const p of mech.PRESETS) {
    assert.ok(linkage.CAPABILITY_TEXT.toLowerCase().includes(distinctive(p.name)),
      `the linkage capabilities never mention ${p.name}`);
  }
  const scenes = await import("../js/light/presets.js");
  for (const p of scenes.PRESETS) {
    assert.ok(light.CAPABILITY_TEXT.toLowerCase().includes(distinctive(p.name)),
      `the light capabilities never mention ${p.name}`);
  }

  /* The optics page's "presets" are the two arrangements in front of the
     camera, and the lens designs are the other thing the menu offers. */
  const sd = await import("../js/optics/scenedesc.js");
  for (const id of sd.PRESETS) {
    assert.ok(optics.CAPABILITY_TEXT.toLowerCase().includes(sd.PRESET_NAMES[id].toLowerCase()),
      `the optics capabilities never mention the ${sd.PRESET_NAMES[id]} scene`);
  }
  const pr = await import("../js/optics/prescription.js");
  for (const id of pr.IDS) {
    assert.ok(optics.CAPABILITY_TEXT.toLowerCase().includes(pr.NAMES[id].toLowerCase()),
      `the optics capabilities never mention the ${pr.NAMES[id]} design`);
  }
});

test("a generated linkage of every offered size actually turns", async () => {
  /* The reason this is deterministic and not planned. A six-bar that MOVES is
     kinematics, not judgement: the dyad lengths are fitted to the swept path of
     the coupler point they hang from, and if that fitting is wrong the thing
     binds partway through the first revolution. So each size is run through a
     full revolution against the real solver, which is the only check that
     means anything here. */
  const gen = await import("../js/linkage/generate.js");
  const S = await import("../js/linkage/solver.js");

  for (const bars of gen.SIZES) {
    const built = gen.buildBars(bars);
    assert.ok(built, `${bars} bars should be buildable`);
    assert.ok(built.motorLink, `${bars} bars: nothing could take a motor`);
    /* b bars counting the ground, j pin joints: 3(b-1) - 2j = 1 for a chain
       with one degree of freedom. */
    assert.equal(3 * (bars - 1) - 2 * built.joints, 1, `${bars} bars: mobility is not one`);

    const m = built.mechanism;
    S.freeze(m);
    const p = S.defaultParams();
    const dt = 1 / 240;
    let bound = -1;
    for (let t = 0; t < 4 && bound < 0; t += dt) {          /* 90 deg/s: 4 s is one turn */
      S.advance(m, dt, p);
      if (S.hasLengthViolation(m, p.lengthTolAbs, p.lengthTolRel)) bound = t;
    }
    assert.equal(bound, -1, `${bars} bars bound up ${bound.toFixed(2)}s into its first revolution`);

    const driven = m.links.find((l) => l.alive && l.isDriven);
    assert.ok(driven.accumulatedAngleRad > Math.PI * 1.9, `${bars} bars did not complete a turn`);
  }

  /* And a size with no such chain is refused rather than fudged. */
  assert.equal(gen.buildBars(5), null);
  assert.equal(gen.buildBars(7), null);
});

test("the numbers a generated linkage reports are the numbers the editor shows", async () => {
  /* The generator used to build the 8-bar coupler with three joints and replace
     it with a four-joint one, which left a tombstone in mechanism.links. The
     editor numbers only living links, so everything after the hole was reported
     one too high: it advertised links 1, 3, 5, 7 as drivable when the editor's
     drivable links were 1, 2, 4, 7, and following that advice selected a link
     with no anchored joint at all. */
  const gen = await import("../js/linkage/generate.js");
  for (const bars of gen.SIZES) {
    const built = gen.buildBars(bars);
    const m = built.mechanism;

    assert.equal(m.links.filter((l) => !l.alive).length, 0,
      `${bars} bars: a tombstoned link pulls every number after it out of step`);

    /* Rebuild the editor's own view of the mechanism and compare. */
    const alive = [];
    m.links.forEach((l) => {
      if (!l.alive) return;
      alive.push({
        n: alive.length + 1,
        anchors: l.connectorIds.filter((c) => m.connectors[c].isAnchor).length,
        driven: l.isDriven,
      });
    });
    assert.equal(built.links, alive.length, `${bars} bars: link count`);
    assert.deepEqual(built.drivable, alive.filter((l) => l.anchors === 1).map((l) => l.n),
      `${bars} bars: the links it says can be driven are not the ones that can`);
    assert.equal(built.motorLink, alive.find((l) => l.driven).n,
      `${bars} bars: the motor is not on the link it claims`);
  }
});

test("asking for a sized linkage builds one instead of planning one", async () => {
  const { looksLikeABuild } = await import("../js/chat/plan.js");
  for (const q of ["build me a six bar linkage", "generate a 6 bar linkage",
                   "make a six-bar mechanism", "build an eight bar linkage"]) {
    const cmds = parse(q, "linkage");
    assert.equal(cmds[0].action, "generate", q);
    assert.equal(looksLikeABuild(q, "linkage"), false, `${q} must not reach the planner`);
  }
  assert.equal(parse("generate a 6 bar linkage with a motor on link 3", "linkage")[0].motorLink, 3);
  /* A named starter still wins: there is a proper Grashof four-bar waiting. */
  assert.equal(parse("build a four bar linkage", "linkage")[0].action, "preset");
});

test("a starter can be asked for by what it does, not just by name", async () => {
  /* Nobody arrives wanting "the Hoeken". They arrive wanting a mechanism that
     draws a straight line, and there is one here built to do exactly that. */
  const wanted = {
    "create a mechanism that draws a straight line": "hoeken",
    "I want something that lifts a platform straight up": "scissor",
    "make a linkage with a quick return stroke": "quick-return",
    "a mechanism that gives simple harmonic motion": "yoke",
    "I need a mechanism that turns rotation into rocking": "four-bar",
    "something chaotic": "pendulum",
  };
  const { looksLikeABuild } = await import("../js/chat/plan.js");
  for (const [said, id] of Object.entries(wanted)) {
    const [cmd] = parse(said, "linkage");
    assert.ok(cmd, `"${said}" matched nothing`);
    assert.equal(cmd.action, "preset", said);
    assert.equal(cmd.id, id, said);
    assert.ok(cmd.because, `${said}: it should say why that one`);
    assert.equal(looksLikeABuild(said, "linkage"), false,
      `${said} has an answer already; it must not go to the planner`);
  }

  /* Naming one still wins over describing one, and the two overlap: "straight
     line" is both the Hoeken's alias and its purpose. */
  const named = parse("show me the scotch yoke", "linkage")[0];
  assert.equal(named.id, "yoke");
  assert.equal(named.because, undefined, "asked for by name, so there is nothing to justify");
});

/* ------------------------------------------------------------- retrieval */

test("a question pulls the section that answers it, and not the whole document", () => {
  const tags = (text) => (text.match(/^<([a-z]+)>/gm) || []).map((t) => t.slice(1, -1));

  const gears = tags(linkage.selectKnowledge("can it do gears?"));
  assert.ok(gears.includes("limits"), "gears is a limits question");
  assert.ok(!gears.includes("exports"), "and has nothing to do with exporting");

  assert.ok(tags(linkage.selectKnowledge("why wont the motor go on")).includes("preconditions"));
  assert.ok(tags(linkage.selectKnowledge("how do I export to blender")).includes("exports"));
  assert.ok(tags(light.selectKnowledge("can it do refraction?")).includes("limits"));
  assert.ok(tags(light.selectKnowledge("why is my surface dark")).includes("preconditions"));
  assert.ok(tags(light.selectKnowledge("what is the scene file format")).includes("scenefile"));

  /* The role is the one section that is always there: it is what stops the
     model answering as though it were somewhere else. */
  for (const [, tool] of TOOLS) {
    for (const q of ["can it do gears?", "what can this do", "anything at all"]) {
      assert.ok(tags(tool.selectKnowledge(q)).includes("role"), q);
    }
  }

  /* And it is a SELECTION. Sending everything is the bug this exists to avoid. */
  assert.ok(linkage.selectKnowledge("can it do gears?").length < linkage.KNOWLEDGE.length * 0.7);
});

/* ------------------------------------------------------------ live state */

test("the state block stays small however big the mechanism gets", () => {
  const joints = Array.from({ length: 40 }, (_, i) => ({
    n: i + 1, x: i * 13.7, y: -i * 2.4, anchor: i < 3, traced: false, selected: false,
  }));
  const block = linkage.formatState({
    preset: "one you built", running: false, gravity: false, sliders: 0, bind: "",
    joints,
    links: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, joints: [i + 1, i + 2], rigid: true })),
    selection: { link: null },
  });
  assert.ok(block.length < 900, `linkage state block is ${block.length} chars`);
  assert.match(block, /\+32 more/, "and it says how many it left out");
  assert.match(block, /joints: 40/, "the counts above the list stay exact");
  /* Coordinates are rounded: a model handed 13.700000000000001 will repeat it. */
  assert.ok(!/\d\.\d/.test(block.split("joint list:")[1] || ""), "no fractional coordinates");

  const lamps = Array.from({ length: 20 }, (_, i) => ({
    n: i + 1, kind: "rect", flux: 200, unit: "lm", kelvin: 5000, p: { x: i / 10, y: 0, z: 0.45 },
  }));
  const scene = light.formatState({
    scene: "one you built", photometric: true, indirect: true, quality: "draft",
    lamps, surfaces: [], selection: null, stats: null,
  });
  assert.ok(scene.length < 900, `light state block is ${scene.length} chars`);
  assert.match(scene, /\+14 more/);
});

/* ---------------------------------------------------------------- budget */

test("a question about the tool is cheaper than a question about the resume", () => {
  /* The whole point of sending one body of knowledge and not both. WebLLM
     prefills the entire system prompt on every message, so this is a wait on
     every turn, not just a context limit. */
  const state = linkage.formatState({
    preset: "four-bar crank-rocker", running: false, gravity: false, sliders: 0, bind: "",
    joints: [{ n: 1, x: -200, y: 0, anchor: true }, { n: 2, x: 200, y: 0, anchor: true }],
    links: [{ n: 1, joints: [1, 2], rigid: true, driven: true, speed: 90 }],
    selection: { link: 1 },
  });
  for (const q of ["why wont the motor go on", "can it do gears?", "what can this do"]) {
    const tool = toolPrompt({ knowledge: linkage.selectKnowledge(q), state });
    assert.ok(tool.length < 4096 * 4 * 0.5, `${q}: ${tool.length} chars is over budget`);
    assert.ok(tool.length < systemPrompt("linkage", selectContext(q)).length,
      `${q}: the tool prompt should be the cheaper of the two`);
  }
});

/* ----------------------------------------------------------------- triage */

test("the questions this feature exists to answer get through the gate", () => {
  /* Every one of these was refused as off topic before the gate learned the
     simulators' vocabulary, including the diagnosis question the whole feature
     is built around. */
  const onLinkage = { domain: "linkage", knowledge: linkage };
  for (const q of ["why wont the motor go on", "can it do gears?", "what about cams",
                   "is there friction", "does it have collision detection"]) {
    const v = triage(q, onLinkage);
    assert.equal(v.kind, "on-topic", q);
    assert.equal(v.subject, "tool", q);
  }
  const onLight = { domain: "light", knowledge: light };
  for (const q of ["does it do refraction?", "can it do caustics", "why is my surface dark",
                   "is there a sky"]) {
    assert.equal(triage(q, onLight).kind, "on-topic", q);
  }
});

test("a question that points at the page is a question about the page", () => {
  /* Reported from the phone: "what does the sim do?" got the resume's off-topic
     refusal. The words in it are all pronouns and stop words, so the term test
     found nothing and the gate fell through to a corpus that has never heard of
     a simulator. Someone standing in front of a tool says "this", not the
     tool's name, and on a simulator page there is exactly one thing being
     pointed at. */
  const onLinkage = { domain: "linkage", knowledge: linkage };
  for (const q of ["what does the sim do?", "what does this do", "what does it do",
                   "what is this thing", "what can it do", "how does this work",
                   "how do I use this", "what am I looking at here"]) {
    const v = triage(q, onLinkage);
    assert.equal(v.kind, "on-topic", q);
    assert.equal(v.subject, "tool", q);
  }
});

test("a how-to about the tool is not a task, and a task is still refused", () => {
  /* Two stoplists pull in opposite directions here and both are needed. The
     retriever ignores "joint" because it appears in every section and so points
     at none of them; the gate must NOT ignore it, because it is the strongest
     evidence a question is about the linkage at all. */
  const onLinkage = { domain: "linkage", knowledge: linkage };
  const onLight = { domain: "light", knowledge: light };
  for (const q of ["how do I add a joint", "how do I make a slider"]) {
    assert.equal(triage(q, onLinkage).kind, "on-topic", q);
  }
  assert.equal(triage("how do I add a lamp", onLight).kind, "on-topic");
  assert.equal(triage("write me a scene file", onLight).kind, "on-topic",
    "a task that names something the tool has is a tool question");

  /* And a task that names nothing here is off topic however hard it points. */
  for (const q of ["translate this to french", "summarise this article", "write me a poem"]) {
    assert.equal(triage(q, onLinkage).kind, "off-topic", q);
    assert.equal(triage(q, onLight).kind, "off-topic", q);
  }
});

test("beside a simulator, you means the assistant and he still means Mark", () => {
  const onLinkage = { domain: "linkage", knowledge: linkage };
  assert.equal(triage("what can you do", onLinkage).subject, "tool",
    "asked next to the tool, this is about the tool");
  assert.equal(triage("what does mark do at tesla", onLinkage).subject, "mark");
  assert.equal(triage("is this the solver he wrote in C", onLinkage).subject, "mark");
});

test("the role is instructions, not subject matter", () => {
  /* The role says "write nothing after the closing tag", and that one word was
     enough to admit "write me a poem" as a question about a linkage. What the
     model is TOLD to do must not vote on what counts as on topic. */
  assert.equal(linkage.TERMS.has("write"), false);
  assert.equal(light.TERMS.has("write"), false);
  /* Nor may a word the document merely uses a lot: "whats" stems to "what". */
  assert.equal(linkage.TERMS.has("what"), false);
  /* But the words that identify the subject must be there. */
  for (const w of ["joint", "motor", "anchor", "slider", "gears", "friction"]) {
    assert.ok(linkage.TERMS.has(w), `the gate should recognise "${w}"`);
  }
  for (const w of ["lamp", "albedo", "refraction", "caustics", "lumens"]) {
    assert.ok(light.TERMS.has(w), `the gate should recognise "${w}"`);
  }
  assert.equal(optics.TERMS.has("write"), false);
  for (const w of ["aperture", "achromat", "vignetting", "pupil", "hyperfocal"]) {
    assert.ok(optics.TERMS.has(w), `the gate should recognise "${w}"`);
  }
});

test("the chat page is unchanged, and nothing lets an off-topic question in", () => {
  /* No knowledge module there, so the resume answers and the old gate holds. */
  assert.equal(triage("can it do gears?", {}).kind, "off-topic");
  assert.equal(triage("what does mark do at tesla", {}).subject, "mark");
  for (const opts of [{}, { domain: "linkage", knowledge: linkage },
                      { domain: "light", knowledge: light },
                      { domain: "optics", knowledge: optics }]) {
    assert.equal(triage("who wrote don quixote", opts).kind, "off-topic");
    assert.equal(triage("what is 2 + 2", opts).kind, "off-topic");
  }
});

/* ---------------------------------------------------------------- layering */

test("the chat module does not know what a coupler is", () => {
  /* js/chat/ is the tool-agnostic half. If it imported a simulator's knowledge
     directly, the Ask page would load both documents to answer a question
     about neither, and the layering that keeps the chat mountable three times
     over would be gone. The knowledge arrives through the controller. */
  for (const name of readdirSync("js/chat")) {
    if (!name.endsWith(".js")) continue;
    const src = readFileSync(`js/chat/${name}`, "utf8");
    const bad = src.match(/from\s+["']\.\.\/(?:linkage|light|optics)\//g);
    assert.equal(bad, null, `js/chat/${name} imports a simulator: ${bad}`);
  }
});

test("the planner is composed from the tool's own document", () => {
  /* Which is what stops the planner's idea of the tool drifting from the
     explanation's idea of it: there is now one list. */
  const sys = planSystem(linkage);
  assert.match(sys, /command compiler/i);
  for (const form of linkage.VOCABULARY) assert.ok(sys.includes(form), `missing "${form}"`);
  assert.ok(sys.includes("PLACE EVERY JOINT FIRST"), "the procedure comes with it");
  assert.ok(planSystem(light).includes("load the workcell"));

  const optSys = planSystem(optics);
  assert.match(optSys, /optics simulator/i,
    "the compiler must know which tool it is compiling for");
  for (const form of optics.VOCABULARY) assert.ok(optSys.includes(form), `missing "${form}"`);
  assert.ok(optSys.includes("The scene is fixed"), "the procedure comes with it");
});

/* ------------------------------------------------------------------ optics */

test("the optics grammar does not reach for controls the page does not have", () => {
  /* The run/pause branch used to be guarded by `domain !== "light"`, which was
     the same thing as "linkage" while there were two tools and quietly wrong
     the moment there were three: "stop down to f/16" came back as an aperture
     change AND a request to pause a simulation that does not exist. */
  for (const said of ["stop down to f/16", "stop down", "open it up", "focus at 3 m"]) {
    const cmds = parse(said, "optics");
    assert.ok(cmds.length, `"${said}" matched nothing`);
    for (const c of cmds) {
      assert.ok(!["run", "pause", "undo", "speed", "addJoint"].includes(c.action),
        `"${said}" produced a ${c.action}, which the optics page cannot do`);
    }
  }
  /* And the linkage still runs and pauses. */
  assert.equal(parse("run it", "linkage")[0].action, "run");
  assert.equal(parse("stop", "linkage")[0].action, "pause");
});

test("a bare number is never mistaken for a setting", () => {
  /* Every optics control is a number, and several share a unit, so a value
     with nothing naming it has to fall through to the model rather than land
     on whichever rule happens to be checked first. */
  for (const said of ["50", "what about 50", "2.8", "tell me about 100 mm"]) {
    const cmds = parse(said, "optics").filter((c) => c.action !== "describe" && c.action !== "help");
    assert.equal(cmds.length, 0, `"${said}" should not have set anything, got ${JSON.stringify(cmds)}`);
  }
  /* But the same numbers with their control named do land. */
  assert.equal(parse("set the focal length to 50 mm", "optics")[0].action, "focal");
  assert.equal(parse("make the sensor 50 mm", "optics")[0].action, "sensor");
});

test("the two units that collide are told apart by the control they name", () => {
  /* Focal length and sensor width are both millimetres. Getting these the wrong
     way round silently reframes the picture. */
  const focal = parse("set the focal length to 85 mm", "optics")[0];
  assert.equal(focal.action, "focal");
  assert.equal(focal.value, 85);
  const sensor = parse("make the sensor 24 mm", "optics")[0];
  assert.equal(sensor.action, "sensor");
  assert.equal(sensor.value, 24);
  /* "Full frame" is a sensor size, and FIT matches the word "frame". */
  const ff = parse("full frame", "optics");
  assert.deepEqual(ff, [{ action: "sensor", value: 36 }]);
});

test("the unit says which source a number is for", () => {
  /* Lux is the sky's and lumens is the lamp's, so neither needs to be told
     which it means. Kelvin is shared, so the noun decides -- and a bare colour
     temperature becomes a generic `colour` for the controller to apply to
     whichever source is actually lighting the scene, because guessing one of
     them would be wrong half the time. */
  assert.deepEqual(parse("set the lamp to 60000 lumens", "optics"),
    [{ action: "lampLumens", value: 60000 }]);
  assert.deepEqual(parse("40000 lm", "optics"), [{ action: "lampLumens", value: 40000 }]);
  assert.deepEqual(parse("set the sky to 5000 lx", "optics"),
    [{ action: "ambientLux", value: 5000 }]);
  assert.deepEqual(parse("make the lamp 3000 K", "optics"),
    [{ action: "lampColour", value: 3000 }]);
  assert.deepEqual(parse("make the sky 5600 K", "optics"),
    [{ action: "skyColour", value: 5600 }]);
  assert.deepEqual(parse("make it 3000 K", "optics"), [{ action: "colour", value: 3000 }]);
});

test("adjusting the sky is not the same as switching to it", () => {
  /* The word "sky" names both the lighting mode and the thing being adjusted.
     Firing both rules gave two answers to one question: "the sky is already
     lighting it", then "sky at 5000 lx". */
  assert.deepEqual(parse("set the sky to 5000 lx", "optics"),
    [{ action: "ambientLux", value: 5000 }]);
  assert.deepEqual(parse("make the sky 5600 K", "optics"),
    [{ action: "skyColour", value: 5600 }]);
  /* Naming it with no value is still a request to switch. */
  assert.deepEqual(parse("switch to the sky", "optics"),
    [{ action: "lighting", value: "ambient" }]);
  assert.deepEqual(parse("switch to the lamps", "optics"),
    [{ action: "lighting", value: "lamps" }]);
});

test("a question about a control is not an instruction to change it", () => {
  for (const said of ["what does the aperture do", "how do I focus closer",
                      "why is the sky brighter", "what is an achromat"]) {
    const cmds = parse(said, "optics").filter((c) => c.action !== "describe" && c.action !== "help");
    assert.equal(cmds.length, 0, `"${said}" should reach the model, got ${JSON.stringify(cmds)}`);
  }
});

test("the Ask page can hand over a link to any of the three tools", () => {
  /* It searched the linkage table only, which made links.js's light branch
     unreachable: it looked up an id in LIGHT_PRESETS that could never have come
     from a light preset. So the one page whose whole job is handing out deep
     links could not hand out two thirds of them. */
  const named = {
    hoeken: "load the Hoeken",
    workcell: "load the workcell",
    rail: "open the optics simulator with the depth rail",
  };
  for (const [id, said] of Object.entries(named)) {
    const [cmd] = parse(said, "links");
    assert.ok(cmd, `"${said}" matched nothing on the Ask page`);
    assert.equal(cmd.action, "preset", said);
    assert.equal(cmd.id, id, said);
  }
});

test("no two tools claim the same preset name", () => {
  /* Which is what makes searching all three tables at once safe. A shared id or
     alias would send the Ask page to the wrong simulator. */
  const all = [...LINKAGE_PRESETS, ...LIGHT_PRESETS, ...OPTICS_PRESETS];
  const ids = new Set();
  for (const p of all) {
    assert.ok(!ids.has(p.id), `two tools both call something "${p.id}"`);
    ids.add(p.id);
  }
  const aliases = new Map();
  for (const p of all) {
    for (const a of p.aliases || []) {
      const owner = aliases.get(a);
      assert.ok(owner === undefined || owner === p.id,
        `"${a}" is an alias for both ${owner} and ${p.id}`);
      aliases.set(a, p.id);
    }
  }
});

test("the optics state block stays small however much is on screen", () => {
  const s = optics.formatState({
    scene: "RAIL", lighting: "AMBIENT", ambientLux: 2000, ambientCctK: 6500,
    lampLm: 20800, lampCctK: 5500,
    design: "ACHROMAT", focalMm: 100, fno: 5, focusM: 2,
    sensorWMm: 36, resW: 320, exposure: 100, cocLimitMm: 0.03, spp: 412,
    derived: { eflMm: 100, hfovDeg: 20.41, pupilMm: 20, tstop: 5.26, colourErrPct: -0.058,
               nearM: 1.94, farM: 2.06, hyperfocalM: 66.77, coversMm: 20.07, coveredMm: 43.25,
               fNumber: 5 },
    targets: Array.from({ length: 40 }, (_, i) => ({ label: `T${i}`, depthM: i, sharp: i === 2 })),
  });
  assert.ok(s.startsWith("<state>") && s.trimEnd().endsWith("</state>"));
  assert.ok(s.length < 900, `the state block is ${s.length} characters`);
  assert.match(s, /f\/5/, "the aperture has to be in there");
});

test("an unbuilt lens says so rather than inventing numbers", () => {
  const s = optics.formatState({
    scene: "RAIL", lighting: "LAMPS", lampLm: 20800, lampCctK: 5500,
    design: "ACHROMAT", focalMm: 100, fno: 5, focusM: 2,
    sensorWMm: 36, resW: 320, exposure: 100, cocLimitMm: 0.03,
    derived: null, spp: 0, targets: [],
  });
  assert.match(s, /has not been built yet/);
  assert.ok(!/NaN|undefined/.test(s), `the state block leaked a placeholder: ${s}`);

  /* And a snapshot missing a field entirely must go quiet rather than print the
     word "undefined", which the model reads as a value and repeats. */
  const bare = optics.formatState({
    scene: "RAIL", lighting: "LAMPS", design: "ACHROMAT", focalMm: 100, fno: 5, focusM: 2,
    sensorWMm: 36, resW: 320, exposure: 100, cocLimitMm: 0.03, derived: null, spp: 0, targets: [],
  });
  assert.ok(!/NaN|undefined/.test(bare), `a partial snapshot leaked a placeholder: ${bare}`);
});
