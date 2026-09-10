/* ---------------------------------------------------------------
   What the assistant knows about the linkage simulator.

   One document, cut on its own XML tags, holding the tool's real capability
   surface and its real limits. It is the single source for three things that
   used to be written out separately and could drift apart: what the planner is
   told, what "what can you do?" prints, and what the model knows when someone
   asks a question in prose.

   Every claim here is checkable against the engine. The limits especially:
   they are what let the assistant say "no, and here is why" instead of
   promising something the solver will then refuse. `tests/chat.test.mjs`
   re-parses every line of <vocabulary> through the command grammar, so a form
   named here that the grammar does not understand fails a test rather than
   silently producing a plan step that is dropped at runtime.

   No DOM in here, so the tests can import it under node.
   --------------------------------------------------------------- */

import { makeRetriever, CHEVRON } from "../chat/retrieve.js?v=281bca3b";

/* The command forms, which are also what the planner is allowed to write. */
export const VOCABULARY = [
  "start from scratch",
  "generate a six bar linkage",
  "place a joint at <x>, <y>",
  "select joints <a> and <b>",
  "select all",
  "select link <n>",
  "link them",
  "anchor it",
  "put a motor on it",
  "make a slider",
  "make it variable",
  "trace the paths",
  "clear the traces",
  "turn gravity on",
  "make it faster",
  "undo that",
  "show me the 3d view",
  "fit the view",
  "run it",
  "stop",
];

const HEAD =
`The linkage simulator on this website: a planar mechanism editor and solver, a
browser port of Mark Gerges's desktop C tool Linkage-Design.`;

const ROLE =
`<role>
You are the assistant beside this simulator. You can drive it and you can
explain it. Answer from the sections below and from <state>, which is what is on
the screen right now. If the answer is not in them, say so rather than inventing
it: a confident wrong answer about a tool the visitor is looking at is worse
than no answer.
Be brief. Two or three sentences unless a list is asked for.
When the visitor's problem is one command away from being fixed, end your answer
with that command on its own line inside <try></try>, worded the way the
commands below are worded. Write nothing after the closing tag, and offer at
most one.
</role>`;

const CAPABILITIES =
`<capabilities>
Build a planar mechanism out of joints, rigid links, sliders, anchors and
motors; run it; watch it in 3D; export it.
- A joint is a pin. Joints are numbered in the order they were placed, and
  those numbers are what you refer to them by.
- A link is a rigid body carrying two or more joints. Two joints make a bar.
  Three or more make a rigid plate, because a link holds every pairwise
  distance between its own joints, not just the neighbouring ones.
- An anchor is a joint fixed to the ground.
- A motor turns one link about one anchored joint at a constant rate.
- A variable link may change length, but only as far as the rest of the
  geometry leaves it no choice.
- A slider holds one joint on the line through two other joints. Rails on
  anchors give a prismatic joint; rails on a moving link give a pin in a slot.
- A traced joint draws its path as the mechanism runs.
- A starter can be asked for by what it DOES rather than by name: a mechanism
  that draws a straight line is the Hoeken, one that lifts a platform straight
  up is the scissor lift, simple harmonic motion is the Scotch yoke, a slow
  stroke out and a fast one back is the Whitworth quick return, turning
  rotation into rocking is the four-bar, a curve no single bar could trace is
  the coupler plate, and chaotic motion is the double pendulum. Each of them
  already traces the point that shows its motion, so running it draws the
  answer on the canvas.
- A whole linkage of a named size, built to order and guaranteed to turn: a
  four, six or eight bar. It arrives anchored, with a motor already on it, and
  it says which joints are anchored and which links could take the motor
  instead. An odd number of bars has no closed chain with one degree of
  freedom, so there is nothing to build for one.
- Eight starter mechanisms: the four-bar crank-rocker, the Hoeken straight-line
  linkage, the drag link, the triangular coupler plate, the Scotch yoke, the
  Whitworth quick return, the scissor lift and the double pendulum.
- Two viewports, design and 3D, and a share link that carries the whole
  mechanism in the address.
</capabilities>`;

const PRECONDITIONS =
`<preconditions>
These are the rules the tool enforces. When an action does nothing, one of them
is why, and <state> says which.
- A motor needs EXACTLY ONE anchored joint on the link it drives. Not zero,
  and not two. Anchoring both ends of a bar is the usual reason a motor will
  not go on; free one end and it will.
- A motor also needs that link to be selected first.
- Linking needs two or more joints selected. Linking clears the selection
  afterwards, so the next action starts from nothing selected.
- A slider needs exactly three joints, chosen in order: the pin first, then the
  two that define its rail.
- Making a link variable needs a selected link that is not driven by a motor. A
  driven link is always rigid.
- All editing is blocked while the mechanism is running. Stop it first.
- Anchoring and tracing act on the whole selection at once, setting all of it
  to one state.
- Unanchoring a joint removes the motor from every link that pivots on it.
- Deleting a joint deletes every link and every slider that used it.
- Bound up means a fixed-length link would have to change length to go any
  further. Only Stop recovers, and Stop returns the design as it was drawn.
</preconditions>`;

const LIMITS =
`<limits>
Things this tool genuinely cannot do. Say so plainly when one is asked for.
- No gears, racks, cams, Geneva wheels, belts, pulleys, chains, springs,
  dampers or ratchets. The desktop C original prints gears, racks, cams and
  Geneva wheels; this browser port has pin joints and sliders only, so those
  have no counterpart here rather than a broken one.
- No mass, weight, forces, torque or inertia. A motor turns at its set rate
  whatever is downstream of it: there is no load, no stall and no power.
- No collision and no contact. Links pass straight through one another.
- No friction and no damping beyond a little on the gravity step.
- Planar only. Everything is flat; the 3D view is a way of looking at a flat
  mechanism, not a spatial one.
- No joint angle limits, and no travel stops on a slider: its rail is a line,
  not a segment, so a pin can run past both of the joints that define it.
- No degrees-of-freedom analysis. Nothing counts mobility in advance, which is
  why three bars closed into a triangle simply will not move, and why binding
  is reported when it happens rather than predicted.
- No redo. Undo goes back fifty steps and is wiped by loading a starter.
- No numeric editing of an existing joint: a joint is placed at a coordinate,
  and after that it moves by dragging.
- No snapping, dimensions, angle readout, or parallel and perpendicular
  constraints.
- The share link is lossy on purpose: coordinates to two decimals, and no rest
  lengths, motor angle or traced paths.
</limits>`;

const NUMBERS =
`<numbers>
- A new motor runs at 90 degrees per second, and faster and slower move it in
  steps of 10. There is no limit in either direction, and a negative speed just
  turns the other way.
- Coordinates are plain numbers with no unit. The starter mechanisms span a few
  hundred either side of zero, so bars 60 to 350 long and coordinates within
  about 250 of the origin look right.
- The y axis points DOWN, so gravity is positive y and a joint at y 100 sits
  below one at y 0.
- Gravity is a fixed downward acceleration, on or off, not a dial. A mechanism
  with no motor runs under gravity whether or not gravity is switched on;
  otherwise there would be nothing to watch.
</numbers>`;

const EXPORTS =
`<exports>
- The Blender script is an ANIMATION and a skeleton: one cylinder per link edge
  and one empty per joint, keyframed. If any link is driven it covers exactly
  one revolution of the fastest motor, so it loops; otherwise three seconds of
  gravity. If the mechanism binds partway the animation stops where it jammed
  and the script says so. It carries no plates, no holes and no traces.
- The STL export writes OBJECTS, not a skeleton: link plates, slider rails,
  headed pins, caps, spacers and a baseplate, in millimetres, as a zip with a
  manifest. Bodies that share a pin are put on separate layers, and any gap on
  a pin is packed out with a washer. Every solid is checked watertight before
  it is written; one that fails is left out and named in the manifest rather
  than handed to a slicer. It needs at least one link to print anything.
- The share link copies the address, which carries the mechanism itself.
</exports>`;

/* Planning is not retrieved: the planner needs all three of these every time. */
const PROCEDURE =
`<procedure>
PLACE EVERY JOINT FIRST, before any select. Joints are numbered 1, 2, 3 in the
order you place them, and a number you never placed selects nothing.
Use exactly as many joints as the request needs: one bar needs 2 joints, two
bars 3, three bars 4. Never link the last joint back to the first unless a
closed shape was asked for: a closed triangle of bars is rigid and cannot move.
Then, one bar at a time: select two joints, link them.
To drive a link you must anchor one of THAT SAME link's own joints first. A
motor on a link with no anchored joint of its own does nothing at all. So:
select the joint, anchor it, select the link it belongs to, put a motor on it.
Drive one link, not several.
Always start with 'start from scratch' and end with 'run it'.
</procedure>`;

const EXAMPLE =
`<example>
Request: build two bars driven by a motor
start from scratch
place a joint at -80, 0
place a joint at 0, 0
place a joint at 80, 40
select joints 1 and 2
link them
select joints 2 and 3
link them
select joints 1
anchor it
select link 1
put a motor on it
run it
</example>`;

/* The retrievable half: what the tool is, not how to write a plan for it. */
export const KNOWLEDGE = [HEAD, ROLE, CAPABILITIES, PRECONDITIONS, LIMITS, NUMBERS, EXPORTS].join("\n");

/* Sent verbatim to the planner, which needs the whole command surface. */
export const PLANNING = [PROCEDURE, EXAMPLE].join("\n\n");

/* What "what can you do?" prints, without the tags. */
export const CAPABILITY_TEXT = CAPABILITIES.replace(/<\/?capabilities>\n?/g, "").trim();

/* Two stoplists, because they are asked two different questions.

   ENGLISH is ordinary filler, and it is what the topic gate ignores when it
   asks "is this question about the tool at all?" -- there, a word like
   "joint" is the strongest evidence there is.

   FLAT_WORDS adds the words this document uses everywhere, and it is what
   the retriever ignores when it asks "WHICH part of the document?" -- there,
   "joint" appears in every section and so points at none of them. Conflating
   the two made "how do I add a joint" fall off the end of the gate. */
const ENGLISH = "the a an and or of to in on for with at from by is was are were that this it as "
  + "you your can could would should will do does did not no what which when where why how "
  + "one two three make made makes set sets put puts use uses using here";

const FLAT_WORDS = ENGLISH + " joint joints link links linked mechanism simulator tool thing things";

const retriever = makeRetriever({
  text: KNOWLEDGE,
  ...CHEVRON,

  /* The role is always sent; it is what stops the model answering as if it
     were somewhere else. */
  core: ["role"],

  flat: FLAT_WORDS,

  nudges: [
    [/\b(gear|gears|rack|cam|cams|geneva|belt|pulley|chain|spring|damper|friction|collision|collide|mass|weight|force|forces|torque|load|inertia|momentum|dynamics|3d|three ?d|spatial|redo|snap|dimension)\b/i, "limits"],
    [/\b(motor|anchor|anchored|ground|grounded|slider|slide|rail|variable|select|selection|bound|binding|jam|jammed|stuck|refus\w*|won.?t|will not|cannot|can.?t|why)\b/i, "preconditions"],
    [/\b(speed|degrees|fast|slow|coordinate|coordinates|units|scale|gravity|axis|y ?axis|how (?:big|large|long|far))\b/i, "numbers"],
    [/\b(export|exports|blender|stl|print|printable|parts|download|share|link|zip|manifest|watertight)\b/i, "exports"],
    [/\b(what can|capabilit\w*|features?|able to|support|supports|do here|possible)\b/i, "capabilities"],
  ],

  /* Deliberately below the profile's 4000: a <state> block rides along with
     this one, and the two together still come in under what the resume alone
     used to cost. */
  budget: 2500,
});

export const selectKnowledge = (question, budget) => retriever.select(question, budget);
export const SECTIONS = retriever.sections;

/* Every word this document uses, for the topic gate: a question about gears or
   friction has to reach the model to be answered, and the resume's vocabulary
   has never heard of either. */
/* ------------------------------------------------------------ live state

   What is on the screen, as a block the model is told to take every number
   from. It is capped hard: a mechanism with forty joints must not crowd the
   conversation out of a 4096-token window, and a model handed forty
   coordinates invents a forty-first. Eight is enough to reason about, and the
   counts above it are always exact.

   Pure, so tests/knowledge.test.mjs can feed it a big mechanism and check the
   caps hold without a browser. */
const JOINT_CAP = 8;
const LINK_CAP = 6;
const STATE_CAP = 800;

export function formatState(s) {
  const out = [];
  const round = (v) => Math.round(v);

  out.push(`mechanism: ${s.preset || "one you built"}; running: ${s.running ? "yes" : "no"}`
    + `; gravity: ${s.gravity ? "on" : "off"}`);

  const anchored = s.joints.filter((j) => j.anchor).length;
  const driven = s.links.filter((l) => l.driven);
  out.push(`joints: ${s.joints.length} (${anchored} anchored); links: ${s.links.length}`
    + (driven.length ? ` (link ${driven.map((l) => l.n).join(" and ")} driven at `
      + `${driven.map((l) => Math.round(l.speed) + " deg/s").join(", ")})` : " (none driven)")
    + (s.sliders ? `; sliders: ${s.sliders}` : ""));

  const picked = s.joints.filter((j) => j.selected).map((j) => j.n);
  out.push("selected: " + (picked.length ? "joint" + (picked.length > 1 ? "s " : " ") + picked.join(", ")
    : s.selection && s.selection.link ? "link " + s.selection.link : "nothing"));

  if (s.joints.length) {
    const shown = s.joints.slice(0, JOINT_CAP).map((j) => {
      const tags = [j.anchor && "anchored", j.traced && "traced"].filter(Boolean).join(" ");
      return `${j.n} (${round(j.x)},${round(j.y)})${tags ? " " + tags : ""}`;
    });
    out.push("joint list: " + shown.join("; ")
      + (s.joints.length > JOINT_CAP ? `; +${s.joints.length - JOINT_CAP} more` : ""));
  }

  if (s.links.length && s.links.length <= LINK_CAP) {
    out.push("link list: " + s.links.map((l) => `${l.n} joins joints ${l.joints.join(" and ")}`
      + (l.driven ? " driven" : "") + (l.rigid === false ? " variable" : "")).join("; "));
  }

  /* The tool's own diagnosis, in its own words. The single most useful line
     here when something has gone wrong. */
  if (s.bind) out.push("note: " + s.bind);

  const text = out.join("\n");
  return "<state>\n" + (text.length > STATE_CAP ? text.slice(0, STATE_CAP - 1) + "\u2026" : text) + "\n</state>";
}

export const TERMS = (() => {
  /* The DISTINCTIVE vocabulary, not every word. Built from the document with
     the same common words the retriever ignores taken out: "what", "does" and
     "the" appear all over a page of prose about a tool, and a gate that counts
     them admits anything at all. */
  const common = new Set(ENGLISH.split(/\s+/));
  /* The role is instructions TO the model, not subject matter about the tool,
     so it must not vote on what counts as on topic. It says "write nothing
     after the closing tag", and that one word was enough to let "write me a
     poem" through as a question about a linkage. */
  const subject = KNOWLEDGE.replace(/<role>[\s\S]*?<\/role>/i, "");
  return new Set(subject.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .filter((w) => w.length >= 3 && !common.has(w)));
})();
