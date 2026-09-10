/* ---------------------------------------------------------------
   Turning what a visitor types into simulator commands.

   This is deliberately NOT the language model's job. The models that fit in a
   browser tab are 0.6B to 2B parameters; they will emit a plausible-looking
   tool call for a mechanism that does not exist, or quietly answer in prose
   when you asked them for JSON. A wrong sentence about a resume is a wrong
   sentence. A wrong tool call reaches into the simulator and changes what the
   visitor is looking at, so it is held to a higher bar.

   So the grammar is matched here first, on a closed vocabulary supplied by the
   page. Anything this file recognises is executed exactly, instantly, and
   without touching the GPU. Anything it does not recognise falls through to the
   model, which answers in prose and cannot press any buttons. The model is
   allowed to be wrong about words; it is not allowed to be wrong about actions.

   No DOM in here, which is what lets tests/chat.test.mjs run the whole grammar
   under node.
   --------------------------------------------------------------- */

/* Aliases are what a visitor would actually say, not what the menu calls it.
   Someone who wants the Hoeken says "the straight line one". */
/* Aliases answer "which one is this?". `does` answers "which one do I want?",
   which is the question someone actually arrives with: "a mechanism that draws
   a straight line" names no mechanism at all, and every one of these was built
   precisely to do the thing it matches. Each preset already traces the point
   that shows its characteristic motion, so loading one and running it draws the
   answer on the canvas. */
export const LINKAGE_PRESETS = [
  { id: "four-bar", name: "four-bar crank-rocker",
    aliases: ["four bar", "fourbar", "4 bar", "crank rocker", "crank-rocker", "grashof"] ,
    does: /\b(rotation (?:in)?to (?:a )?rock|rocking|oscillat\w*|back and forth|to and fro|swing\w* arm|wiper)\b/i,
    because: "a turning crank rocks the far arm back and forth, and the coupler point traces the classic figure" },
  { id: "hoeken", name: "Hoeken straight-line linkage",
    aliases: ["hoeken", "hoekens", "straight line", "straight-line", "straightline"] ,
    does: /\b(straight ?line|straight motion|straighten|linear motion|in a line|without a (?:slide|rail|slideway))\b/i,
    because: "it turns rotation into very nearly straight motion, with no slideway anywhere in it" },
  { id: "drag-link", name: "drag link",
    aliases: ["drag link", "draglink", "drag-link", "double crank"] ,
    does: /\b(both cranks|continuous rotation|full rotation out|varying speed|speeds up and slows)\b/i,
    because: "the ground is the shortest link, so both cranks turn fully and the output runs at a varying speed" },
  { id: "ternary", name: "triangular coupler plate",
    aliases: ["ternary", "coupler plate", "triangular", "triangle", "rigid plate", "three joint"] ,
    does: /\b(coupler curve|complex curve|figure of eight|figure eight|curve no (?:single )?bar|odd curve|fancy curve)\b/i,
    because: "its coupler is a rigid three-joint plate, so the apex traces a curve no single bar could" },
  { id: "yoke", name: "Scotch yoke",
    aliases: ["scotch yoke", "yoke", "sine", "sinusoid"] ,
    does: /\b(sine|sinusoid\w*|simple harmonic|harmonic motion|exactly reciprocat\w*|pure reciprocat\w*)\b/i,
    because: "the crank pin runs in a slot across a sliding yoke, so the travel is an exact sine of the crank angle" },
  { id: "quick-return", name: "Whitworth quick return",
    aliases: ["quick return", "quick-return", "whitworth", "shaper", "shaping machine"] ,
    does: /\b(quick return|fast return|slow (?:out|forward).{0,12}fast back|shaping machine|shaper stroke|cutting stroke)\b/i,
    because: "the lever is pivoted off to one side, so the ram goes out slowly and comes back fast" },
  { id: "scissor", name: "scissor lift",
    aliases: ["scissor lift", "scissor", "scissors"] ,
    does: /\b(lift|lifts|lifting|raise|raises|hoist|platform|straight up|jack)\b/i,
    because: "crossed arms on a sliding foot raise the platform straight up" },
  { id: "pendulum", name: "double pendulum",
    aliases: ["double pendulum", "pendulum", "chaotic", "chaos"] ,
    does: /\b(chaos|chaotic|unpredictab\w*|sensitive to initial|butterfly)\b/i,
    because: "it runs under gravity alone with no motor, and the motion is genuinely chaotic" },
];

export const LIGHT_PRESETS = [
  { id: "workcell", name: "inspection workcell",
    aliases: ["workcell", "work cell", "inspection", "enclosure", "led array", "2x2", "2 x 2"] },
  { id: "single-panel", name: "single panel over a bare surface",
    aliases: ["single panel", "one panel", "bare surface", "inverse square", "falloff", "cosine law"] },
  { id: "spot", name: "spot on a curved part",
    aliases: ["spot on", "raking", "tungsten", "curved part", "sphere", "glare"] },
  /* "warm" and "cool" on their own are far too greedy: "two warm panels over a
     grey floor" is a description of a rig to build, not a request for this
     scene, and a bare alias turned it into one. The alias has to be the pairing
     itself. */
  { id: "two-source", name: "warm and cool together",
    aliases: ["two source", "warm and cool", "warm against", "warm vs cool", "2700", "6500",
              "colour temperature", "color temperature", "mixed spectra"] },
  { id: "sun", name: "daylight through an opening",
    aliases: ["sun", "sunlight", "daylight", "hard shadow", "directional source", "penumbra"] },
];

/* The optics page fixes its scene, so a "preset" here is which arrangement is
   in front of the camera rather than something to build. Two of them, and both
   are asked for by what they show far more often than by name. */
export const OPTICS_PRESETS = [
  { id: "rail", name: "depth rail",
    aliases: ["depth rail", "rail", "targets", "five spheres", "depth targets", "focus chart"],
    does: /\b(depth of field|depth-of-field|what.{0,4}s in focus|how much is sharp|focus test|rack focus)\b/i,
    because: "five identical targets at known distances, so the only difference between them in the image is how far out of focus they are" },
  { id: "bokeh", name: "bokeh lights",
    aliases: ["bokeh", "blur disc", "blur discs", "out of focus lights", "point lights", "highlights"],
    does: /\b(bokeh|shape of the blur|blur shape|iris shape|aperture shape|what the iris looks like)\b/i,
    because: "small bright sources against nothing, so a defocused one takes the shape of the iris" },
];

/* ------------------------------------------------------------- the grammar */

/* Which table a domain's presets live in. One place, so adding a third tool
   did not mean finding every `domain === "light"` and hoping. */
export function presetsFor(domain) {
  if (domain === "light") return LIGHT_PRESETS;
  if (domain === "optics") return OPTICS_PRESETS;
  return LINKAGE_PRESETS;
}

/* A word that means "put this on the screen". Without one of these a preset
   name is a QUESTION about that mechanism, not a request to load it: "what is
   a Scotch yoke" must reach the model, not the simulator. */
const LOAD = /\b(load|show|open|switch(?: to)?|give|bring|display|use|try|pull up|go to|put|set up|start(?: with)?|run|see|watch|demo|build|construct)\b/i;

/* "go" alone is too eager: "go to fine quality" is not a request to run. And
   "start" is not, either, when what follows is "from scratch": that is a
   request for an empty canvas, and running an empty mechanism is the opposite
   of what was asked for. */
const RUN    = /\b(run|start(?! (?:from|over|fresh|afresh|again with|with a blank|with an empty))|play|animate|resume|begin|move it|make it move|get it going|go ahead|spin|spins|spinning)\b/i;
const PAUSE  = /\b(pause|stop|halt|freeze|hold it|stand still)\b/i;
const FASTER = /\b(faster|quicker|speed(?: it)? up|more speed|sped up|hurry|as fast|go fast|double the speed)\b/i;
const SLOWER = /\b(slower|slow(?: it)? down|less speed|slow down|calm down|halve the speed)\b/i;
const FIT    = /\b(fit|frame|centre|center|zoom (?:to )?fit|reset the view|recentre|recenter|zoom out)\b/i;
const DESCRIBE = /\b(what am i (?:looking at|seeing)|what(?:'s| is) (?:on screen|on the screen|running|loaded|this)|describe (?:it|this|the (?:scene|mechanism))|read(?: it)? (?:back|out)|what does it (?:read|say)|current state|status)\b/i;
const HELP   = /\b(what can you (?:do|control|change)|how do i (?:use|drive) (?:this|it)|what controls|which (?:commands|controls)|help)\b/i;

/* How much a "faster" is worth. The editor's nudge is one step, so an emphatic
   request is several nudges rather than a different unit. */
const MUCH = /\b(much|way|lot|far|loads|significantly|considerably|3x|three times)\b/i;
const TWICE = /\b(twice|2x|double|two times)\b/i;
function magnitude(text) {
  if (MUCH.test(text)) return 3;
  if (TWICE.test(text)) return 2;
  const m = /\b(\d)\s*(?:x|times)\b/i.exec(text);
  if (m) return Math.min(5, Math.max(1, Number(m[1])));
  return 1;
}

/* on/off/toggle, for the switches that have all three. The qualifier can land
   on either side of the subject ("turn gravity on", "turn on gravity"), so both
   sides of the mention are read rather than one alternation being tried first
   and winning with nothing in it. */
function onOff(text, subject) {
  const at = new RegExp(`\\b${subject}\\b`, "i").exec(text);
  if (!at) return null;
  const window = (text.slice(Math.max(0, at.index - 26), at.index)
    + " " + text.slice(at.index + at[0].length, at.index + at[0].length + 26)).toLowerCase();
  if (/\b(off|disable|disabled|without|no|remove)\b/.test(window)) return false;
  if (/\b(on|enable|enabled|with|add)\b/.test(window)) return true;
  return null;  /* named but not qualified: the caller toggles */
}

/* Politeness and articles are not part of the name. Stripped before measuring
   how much of the message the name covers, so "the scissor lift please" is as
   much a request for that mechanism as "scissor lift" is. */
const FILLER = /\b(the|a|an|please|thanks|thank you|could you|can you|would you|now|ok|okay|just|me|my|us)\b/g;

function findPreset(text, presets) {
  const t = " " + text.toLowerCase().replace(FILLER, " ").replace(/[^a-z0-9]+/g, " ").trim() + " ";
  let best = null;
  for (const p of presets) {
    for (const a of [p.name, p.id, ...p.aliases]) {
      const needle = " " + a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
      if (t.indexOf(needle) < 0) continue;
      /* "spot light" is a lamp to add, not the spot scene. */
      if ((a === "spot on" || a === "spot") && /\bspot ?(light|lamp)/.test(text.toLowerCase())) continue;
      /* Longest alias wins, so "double pendulum" beats "pendulum" and
         "straight line" is not shadowed by a shorter accidental hit. */
      if (!best || needle.length > best.len) {
        best = { preset: p, len: needle.length, residue: t.replace(needle, " ").trim() };
      }
    }
  }
  return best;
}

/* What may be left over and still leave the message a bare name. "the scissor
   lift please" is a request for that mechanism; "add a sphere" is not a request
   for the scene whose alias is "sphere", because "add" survives here. */
const RESIDUE_OK = new Set(["one", "thing", "mechanism", "linkage", "scene", "preset",
                            "example", "version", "mode", "setup", "instead", "next", "too"]);

/* ------------------------------------------------------------- numbers

   Coordinates and quantities, pulled out of ordinary sentences: "place a joint
   at 120, 40", "move it to 0.1 0 0.45", "set it to 400 lumens", "2700K". Signs
   and decimals are kept; anything else in the sentence is ignored. */
function numbers(text) {
  return (text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}

/* Joint numbers in "select joints 1 and 3" or "joints 2, 4". */
function ordinals(text) {
  const m = /\b(?:joints?|nodes?|points?|links?|bars?|lamps?|lights?|surfaces?)\s+((?:\d+\s*(?:,|and|&|\s)\s*)*\d+)/i.exec(text);
  if (!m) return [];
  return (m[1].match(/\d+/g) || []).map(Number);
}

/* Is this an imperative at all, or a question about the subject? Questions are
   the model's, commands are ours. */
/* "Should I" is asking for advice, not issuing a request. "Could you" and
   "would you" are the opposite -- polite imperatives -- so they stay out. */
const ASKING = /^\s*(what|why|how|who|when|which|is|are|does|do|did|should|shall|can you (?:tell|explain)|tell me|explain|describe (?:how|why|what))\b/i;

/* ------------------------------------------------------------------ parse */

/* ------------------------------------------------------------- sequences

   One message is usually one instruction, but building anything is not: "place
   a joint at 0 0, then one at 60 0, then link them" is three, and they have to
   happen in the order they were said rather than in the canonical order a
   single clause gets sorted into.

   So the message is cut into clauses first and each is parsed on its own. The
   hard part is knowing which commas and "and"s are punctuation and which are
   part of an argument: "joints 1 and 3" and "at 0, 0" are one thing each. A
   separator between two NUMBERS is never punctuation, which is the whole rule.

   Clause results are concatenated, never re-sorted and never de-duplicated
   against each other: two joints at different places are two steps, and asking
   for the same thing twice is the visitor's business. */

/* Two markers, because the two kinds of protected separator restore
   differently: a comma inside "0, 0" comes back as a comma, and the "and"
   inside a scene's name comes back as the word. And masking has to REMOVE the
   separator from the text the splitter sees, not merely flag it, or the split
   happens anyway -- which is what a single marker around the word did. */
const MARK_COMMA = "\u0001";
const MARK_AND = "\u0002";

/* Names that contain a separator word are one thing, not two: "warm and cool
   together" is a scene, and splitting it produced two clauses that meant
   nothing on their own. */
function protectedPhrases(presets) {
  const out = [];
  for (const p of presets) {
    for (const a of [p.name, ...p.aliases]) if (/(?:,|\band\b)/i.test(a)) out.push(a);
  }
  /* Longest first, so a name is never half-masked by a shorter one inside it. */
  return out.sort((a, b) => b.length - a.length);
}

const mask = (t) => t.replace(/,/g, MARK_COMMA).replace(/\band\b/gi, MARK_AND);
const unmask = (t) => t.split(MARK_COMMA).join(",").split(MARK_AND).join("and");

export function splitClauses(text, presets = []) {
  let guarded = String(text || "");
  for (const phrase of protectedPhrases(presets)) {
    guarded = guarded.replace(
      new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => mask(m)
    );
  }
  /* "1 and 3", "0, 0" -- an argument, not a break. Both come back as a comma,
     which is how every argument list here is written anyway. */
  guarded = guarded.replace(/(-?\d(?:\.\d+)?)\s*(?:,|\band\b|&)\s*(?=-?\d)/gi,
                            `$1${MARK_COMMA} `);
  return guarded
    .split(/\s*(?:;|\bthen\b|,|\band\b|\bafter that\b|\bnext\b)\s*/i)
    .map((c) => unmask(c).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/* A clause that names a place but no action, after one that placed something:
   "place a joint at 0 0, then one at 60 0". The verb carries over rather than
   the second half being dropped, which is how anyone would read it. */
const ELIDED = /^(?:(?:and\s+)?(?:one|another|then)\b|\(?-?\d)/i;

export function parse(text, domain) {
  const clauses = splitClauses(text, presetsFor(domain));
  if (clauses.length < 2) return parseClause(text, domain);

  const out = [];
  for (const clause of clauses) {
    let got = parseClause(clause, domain);
    if (!got.length && ELIDED.test(clause) && numbers(clause).length >= 2) {
      const prev = out[out.length - 1];
      if (prev && prev.action === "addJoint") {
        const n = numbers(clause);
        got = [{ action: "addJoint", x: n[0], y: n[1], add: false }];
      }
    }
    out.push(...got);
  }
  return out;
}

/* Returns an ordered list of {action, ...} to apply, or [] for "not a command
   for me". Within ONE clause the order is canonical rather than as-typed: load,
   then configure, then run, so "run the hoeken" loads it before starting it
   whichever way round the visitor said it. */
function parseClause(text, domain) {
  const raw = String(text || "");
  if (!raw.trim()) return [];
  const cmds = [];

  if (DESCRIBE.test(raw)) return [{ action: "describe" }];
  if (HELP.test(raw) && !LOAD.test(raw)) return [{ action: "help" }];

  const presets = presetsFor(domain);
  const hit = findPreset(raw, presets);

  /* A preset name loads it when the sentence asks for it, or when the message
     is nothing BUT the name. Anything else that merely mentions it is a
     question for the model. */
  const bare = hit && hit.residue.split(/\s+/).filter(Boolean).every((w) => RESIDUE_OK.has(w));
  const named = hit && (LOAD.test(raw) || bare);
  if (named && (!ASKING.test(raw) || LOAD.test(raw))) {
    cmds.push({ action: "preset", id: hit.preset.id, name: hit.preset.name });
  }

  /* Asked for by what it DOES rather than by what it is called. "Create a
     mechanism that draws a straight line" names nothing, and there is a linkage
     here built to do exactly that.

     Checked AFTER the name test rather than instead of it, because the two
     overlap: "straight line" is both the Hoeken's alias and its purpose, so
     matching names first and functions second means "show me the Hoeken" and
     "something that draws a straight line" both land on it, by different
     routes and for different reasons. */
  if (!cmds.some((c) => c.action === "preset") && !ASKING.test(raw)) {
    const wanted = presets.find((p) => p.does && p.does.test(raw));
    if (wanted && /\b(want|need|make|build|create|generate|give|show|find|produce|something|anything|that|which|with|for)\b/i.test(raw)) {
      cmds.push({ action: "preset", id: wanted.id, name: wanted.name, because: wanted.because });
    }
  }

  const asking = ASKING.test(raw) && !LOAD.test(raw);

  if (domain === "light") {
    if (/\b(lux|photometric|illuminance)\b/i.test(raw) && !asking) cmds.push({ action: "units", value: "lux" });
    /* Deliberately not a bare "watt": "give it 12 watts" is a lamp's flux, not
       a request to switch the whole readout to irradiance. Only the per-area
       forms mean the unit system. */
    else if (/(\bw\s*[\/·]\s*m|watts? per square|per square met|\birradiance\b|\bradiometric\b)/i.test(raw) && !asking) {
      cmds.push({ action: "units", value: "irradiance" });
    }

    const ind = onOff(raw, "(?:interreflection|bounce|bounces|indirect)");
    if ((ind !== null || /\b(direct only|direct-only|no bounces)\b/i.test(raw)) && !asking) {
      cmds.push({ action: "indirect", value: /\b(direct only|direct-only|no bounces)\b/i.test(raw) ? false : ind });
    }
    if (/\b(fine|high quality|better quality|more samples|accurate)\b/i.test(raw) && !asking) cmds.push({ action: "quality", value: "fine" });
    else if (/\b(draft|fast(?:er)? quality|low quality|quick pass)\b/i.test(raw) && !asking) cmds.push({ action: "quality", value: "draft" });

    const nums = numbers(raw);
    const picks = ordinals(raw);

    /* --- picking something to edit --- */
    if (/\b(select|pick|choose|edit|grab)\b/i.test(raw) && !asking && picks.length) {
      cmds.push({
        action: "pick",
        kind: /\b(surface|prim|quad|sphere|wall|floor|plate|part)\b/i.test(raw) ? "prim" : "light",
        n: picks[0],
      });
    }

    /* --- editing whatever is picked --- */
    const patch = {};
    const lm = /(-?\d+(?:\.\d+)?)\s*(?:lm\b|lumens?)/i.exec(raw);
    const watt = /(-?\d+(?:\.\d+)?)\s*(?:w\b|watts?)(?!\s*\/|\s*per)/i.exec(raw);
    if (lm) patch.flux = { value: Number(lm[1]), unit: "lm" };
    else if (watt) patch.flux = { value: Number(watt[1]), unit: "W" };

    const kelvin = /(\d{3,5})\s*(?:k\b|kelvin)/i.exec(raw);
    if (kelvin) patch.temperature = Number(kelvin[1]);
    /* "Make it warmer" is an instruction; "two warm panels over a grey floor" is
       a description of something to build. Only the first is a colour change,
       so the adjective has to arrive with a verb that acts on the selection. */
    const setsIt = /\b(make|set|turn|change|warm it|cool it)\b/i.test(raw);
    if (!kelvin && setsIt && /\bwarm(?:er)?\b/i.test(raw) && !findPreset(raw, presets)) patch.temperature = 2700;
    else if (!kelvin && setsIt && /\bcool(?:er)?\b/i.test(raw) && !findPreset(raw, presets)) patch.temperature = 6500;

    const cone = /(\d+(?:\.\d+)?)\s*(?:°|deg|degrees?)/i.exec(raw);
    if (cone && /\b(cone|beam|spread|angle)\b/i.test(raw)) patch.cone = Number(cone[1]);

    const albedo = /\b(?:albedo|reflectance|reflectivity)\b[^.]{0,16}?(-?\d*\.?\d+)|(-?\d*\.?\d+)[^.]{0,16}?\b(?:albedo|reflectance)\b/i.exec(raw);
    if (albedo) patch.albedo = Number(albedo[1] ?? albedo[2]);

    const radius = /\b(?:radius|size)\b[^.]{0,16}?(-?\d*\.?\d+)/i.exec(raw);
    if (radius) patch.radius = Number(radius[1]);

    if (/\b(move|position|put|place)\b[^.]{0,20}?\b(?:to|at)\b/i.test(raw) && nums.length >= 3) {
      patch.position = { x: nums[0], y: nums[1], z: nums[2] };
    } else if (/\b(raise|lift|lower|drop|move (?:it )?(?:up|down))\b/i.test(raw)) {
      const by = nums.length ? Math.abs(nums[0]) : 0.05;
      patch.move = { x: 0, y: 0, z: /\b(lower|drop|down)\b/i.test(raw) ? -by : by };
    }
    if (Object.keys(patch).length && !asking) cmds.push({ action: "edit", patch });

    if (/\b(delete|remove|get rid of)\b/i.test(raw) && !asking) cmds.push({ action: "remove" });
    if (/\b(download|save|export)\b[^.]{0,20}?\b(scene|file)\b/i.test(raw) && !asking) {
      cmds.push({ action: "download" });
    }
    if (/\b(share|copy the link|link to this|permalink)\b/i.test(raw) && !asking) cmds.push({ action: "share" });
    if (/\b(list|what lamps|which lamps|what is in|what's in|name the lamps|how many lamps)\b/i.test(raw)) {
      cmds.push({ action: "list" });
    }

    /* "How do I add a sphere?" is a question about adding one, and it was
       adding one. Every other rule in this branch carries the same guard; these
       two were simply missing it. */
    const add = /\b(add|place|put|insert|drop|create)\b/i.test(raw) && !patch.position && !asking;
    if (add) {
      if (/\b(rect|rectangular|panel|area)\b/i.test(raw)) cmds.push({ action: "addLight", kind: "rect" });
      else if (/\bspot ?(?:light|lamp)?\b/i.test(raw)) cmds.push({ action: "addLight", kind: "spot" });
      else if (/\bpoint ?(?:light|lamp|source)?\b/i.test(raw)) cmds.push({ action: "addLight", kind: "point" });
      if (/\b(sphere|ball)\b/i.test(raw)) cmds.push({ action: "addPrim", kind: "sphere" });
      else if (/\b(quad|plate|panel surface|wall|board)\b/i.test(raw)) cmds.push({ action: "addPrim", kind: "quad" });
    }
  } else if (domain === "optics") {
    /* Nothing here adds or deletes anything: the scene is fixed and the camera
       is what a visitor changes. So every command is a SETTING, and the whole
       branch is "which number did they mean".

       Units carry the meaning, because a bare number cannot: 50 could be a
       focal length, a sensor width or an exposure. Every rule below therefore
       needs either a unit or a word naming the control, and a sentence with
       neither is a question for the model. */

    /* --- the lens design --- */
    if (!asking) {
      if (/\b(achromat|doublet|corrected|fraunhofer|cemented)\b/i.test(raw)) {
        cmds.push({ action: "design", value: "achromat" });
      } else if (/\b(singlet|single element|one element|uncorrected|bk7 alone)\b/i.test(raw)) {
        cmds.push({ action: "design", value: "singlet" });
      } else if (/\b(ideal|perfect lens|thin lens|aberration.?free|no aberration)\b/i.test(raw)) {
        cmds.push({ action: "design", value: "thin" });
      }
    }

    /* --- aperture ---
       f/2.8, f2.8, "f 2.8", or the word with a number nearby. "Open up" and
       "stop down" are the two things a photographer says without a number at
       all, so they get a relative form. */
    const fno = /\bf\s*[\/\\]?\s*(\d+(?:\.\d+)?)\b/i.exec(raw)
             || (/\b(aperture|f.?stop|f.?number|stop)\b/i.test(raw)
                 ? /(\d+(?:\.\d+)?)/.exec(raw) : null);
    if (fno && !asking) cmds.push({ action: "aperture", value: Number(fno[1]) });
    else if (!asking && /\b(open (?:it )?up|wide open|open the aperture|shallower)\b/i.test(raw)) {
      cmds.push({ action: "aperture", stops: -1 });
    } else if (!asking && /\b(stop (?:it )?down|close (?:it )?down|stop down|deeper)\b/i.test(raw)) {
      cmds.push({ action: "aperture", stops: +1 });
    }

    /* --- focus ---
       Metres, and only when the sentence is about focusing. "2 m" in a
       sentence about a sensor is not a focus distance. */
    const focusAt = /\b(?:focus(?:ed|ing)?|focal plane|sharp)\b[^.]{0,24}?(-?\d+(?:\.\d+)?)\s*(?:m\b|metres?|meters?)/i.exec(raw)
                 || /(-?\d+(?:\.\d+)?)\s*(?:m\b|metres?|meters?)[^.]{0,16}?\b(?:focus|away|out|distance)\b/i.exec(raw);
    if (focusAt && !asking) cmds.push({ action: "focus", value: Number(focusAt[1]) });
    else if (!asking && /\bfocus\b[^.]{0,20}?\b(infinity|infinite|far away|the horizon)\b/i.test(raw)) {
      cmds.push({ action: "focus", value: Infinity });
    }

    /* --- focal length ---
       Millimetres, but so is the sensor, so the control has to be named. */
    const focal = /\b(?:focal(?: length)?|lens|zoom)\b[^.]{0,24}?(\d+(?:\.\d+)?)\s*(?:mm\b|millimet\w*)/i.exec(raw)
               || /(\d+(?:\.\d+)?)\s*(?:mm\b|millimet\w*)[^.]{0,16}?\b(?:lens|focal)\b/i.exec(raw);
    if (focal && !asking) cmds.push({ action: "focal", value: Number(focal[1]) });

    /* --- the sensor --- */
    const sensor = /\b(?:sensor|film|format|frame)\b[^.]{0,24}?(\d+(?:\.\d+)?)\s*(?:mm\b|millimet\w*)/i.exec(raw)
                || /(\d+(?:\.\d+)?)\s*(?:mm\b|millimet\w*)[^.]{0,16}?\b(?:sensor|film|format|frame)\b/i.exec(raw);
    if (sensor && !asking) cmds.push({ action: "sensor", value: Number(sensor[1]) });
    else if (!asking && /\bfull ?frame\b/i.test(raw)) cmds.push({ action: "sensor", value: 36 });
    else if (!asking && /\b(aps.?c|crop sensor)\b/i.test(raw)) cmds.push({ action: "sensor", value: 23.6 });

    /* --- the iris --- */
    /* Nobody says "9 blades" out loud; they say "nine blades". */
    const BLADE_WORDS = { three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
                          nine: 9, ten: 10, eleven: 11, twelve: 12 };
    const bladeWord = new RegExp(`\\b(${Object.keys(BLADE_WORDS).join("|")})[\\s-]*blade`, "i").exec(raw);
    const blades = /(\d+)\s*(?:-|\s)?blade/i.exec(raw)
                || /\bblades?\b[^.]{0,16}?(\d+)/i.exec(raw);
    if (blades && !asking) cmds.push({ action: "blades", value: Number(blades[1]) });
    else if (bladeWord && !asking) {
      cmds.push({ action: "blades", value: BLADE_WORDS[bladeWord[1].toLowerCase()] });
    }
    else if (!asking && /\b(round|circular|perfect circle) (?:iris|aperture|blades?)\b/i.test(raw)) {
      cmds.push({ action: "blades", value: 0 });
    }
    const curve = /\bblade\b[^.]{0,16}?\b(?:curve|curvature|round\w*)\b[^.]{0,16}?(-?\d*\.?\d+)/i.exec(raw);
    if (curve && !asking) cmds.push({ action: "curvature", value: Number(curve[1]) });

    /* --- exposure ---
       A view gain, so it has no unit of its own; the word has to be there. */
    const exp = /\bexposure\b[^.]{0,20}?(-?\d*\.?\d+)/i.exec(raw)
             || /(-?\d*\.?\d+)[^.]{0,12}?\bexposure\b/i.exec(raw);
    if (exp && !asking) cmds.push({ action: "exposure", value: Number(exp[1]) });
    else if (!asking && /\b(brighter|brighten|too dark)\b/i.test(raw)) cmds.push({ action: "exposure", factor: 2 });
    else if (!asking && /\b(darker|darken|too bright|blown out|clipping)\b/i.test(raw)) cmds.push({ action: "exposure", factor: 0.5 });

    /* --- the render grid --- */
    const px = /(\d{2,4})\s*(?:px\b|pixels?\b)/i.exec(raw)
            || /\b(?:render|resolution)\b[^.]{0,16}?(\d{2,4})/i.exec(raw);
    if (px && !asking) cmds.push({ action: "resolution", value: Number(px[1]) });

    /* --- lighting: a choice, not a blend ---

       The sky's own settings are read FIRST, because they decide whether the
       word "sky" meant "switch to it" or merely named the thing being adjusted.
       "Set the sky to 5000 lx" is not a request to switch lighting mode, and
       treating it as one produced two answers to one question: "the sky is
       already lighting it" followed immediately by "sky at 5000 lx". */
    const lux = /(\d+(?:\.\d+)?)\s*(?:lx\b|lux\b)/i.exec(raw);
    const skyK = /(\d{3,5})\s*(?:k\b|kelvin)/i.exec(raw);
    const adjustingTheSky = Boolean(lux || skyK);

    if (!asking && !adjustingTheSky
        && /\b(sky|dome|ambient|overcast|lightbox|light box|no shadows|shadowless)\b/i.test(raw)) {
      cmds.push({ action: "lighting", value: "ambient" });
    } else if (!asking && /\b(lamps?|key light|the panel|placed light|shadows back)\b/i.test(raw)) {
      cmds.push({ action: "lighting", value: "lamps" });
    }
    if (lux && !asking) cmds.push({ action: "ambientLux", value: Number(lux[1]) });
    if (skyK && !asking) cmds.push({ action: "skyColour", value: Number(skyK[1]) });

    /* --- the sharpness criterion --- */
    const coc = /\b(?:sharp if|circle of confusion|coc|blur limit)\b[^.]{0,20}?(-?\d*\.?\d+)/i.exec(raw);
    if (coc && !asking) cmds.push({ action: "coc", value: Number(coc[1]) });

    if (/\b(share|copy the link|link to this|permalink)\b/i.test(raw) && !asking) cmds.push({ action: "share" });
    if (/\b(reset|start over|back to (?:the )?default)\b/i.test(raw) && !asking) cmds.push({ action: "reset" });
    if (/\b(what is sharp|what.?s sharp|which (?:one|target|sphere) is sharp|read ?out|the numbers|depth of field now)\b/i.test(raw)) {
      cmds.push({ action: "list" });
    }
  } else {
    /* --- a whole linkage of a named size ---------------------------

       "Build me a six bar linkage" names an OUTCOME, which is normally the
       planner's job. It is not, here: a six-bar that actually moves is a solved
       problem in kinematics rather than a matter of judgement, and a 2B model
       asked to invent one produces a knot of bars that binds on the first
       revolution. js/linkage/generate.js builds it properly, so the grammar
       takes this before the planner ever sees it. */
    const sized = /\b(?:(\d+)|four|five|six|seven|eight)[\s-]*bar(?:s)?\b/i.exec(raw);
    /* A named starter wins over a generated one: "build a four bar linkage" has
       a proper Grashof crank-rocker waiting for it, blurb and all. */
    const alreadyNamed = cmds.some((c) => c.action === "preset");
    if (sized && !alreadyNamed
        && /\b(generate|build|make|create|give|show|construct|want|need)\b/i.test(raw) && !asking) {
      const words = { four: 4, five: 5, six: 6, seven: 7, eight: 8 };
      const bars = sized[1] ? Number(sized[1]) : words[sized[0].toLowerCase().split(/[\s-]/)[0]];
      /* "with a motor on link 2". Read before the general number sweep below,
         which would otherwise take the bar count for a coordinate. */
      const onLink = /\bmotor\b[^.]{0,20}?\blink\s+(\d+)|\blink\s+(\d+)[^.]{0,20}?\bmotor\b/i.exec(raw);
      cmds.push({ action: "generate", bars, motorLink: onLink ? Number(onLink[1] || onLink[2]) : null });
    }

    /* --- building and selecting, which is the rest of the toolbar --- */
    const nums = numbers(raw);
    const picks = ordinals(raw);

    if (/\b(place|add|put|drop|create|make)\b[^.]{0,24}?\b(joint|node|point|pivot)\b/i.test(raw) && !asking) {
      /* Two numbers are a coordinate; none means "wherever there is room", and
         the editor's own default is as good an answer as any. */
      cmds.push(nums.length >= 2
        ? { action: "addJoint", x: nums[0], y: nums[1], add: /\b(also|another|and|keep)\b/i.test(raw) }
        : { action: "addJoint", x: null, y: null, add: false });
    }

    if (/\b(select|pick|choose|highlight|grab)\b/i.test(raw) && !asking) {
      if (/\b(all|every|everything)\b/i.test(raw)) cmds.push({ action: "select", which: "all" });
      else if (/\banchors?\b|\bgrounded\b/i.test(raw)) cmds.push({ action: "select", which: "anchors" });
      else if (/\btraced?\b/i.test(raw)) cmds.push({ action: "select", which: "traced" });
      else if (/\b(link|bar)\b/i.test(raw) && picks.length) cmds.push({ action: "selectLink", n: picks[0] });
      else if (picks.length) cmds.push({ action: "select", which: "ids", ids: picks });
      else if (/\blast\b/i.test(raw)) cmds.push({ action: "select", which: "last", count: nums[0] || 2 });
    }
    if (/\b(deselect|unselect|clear the selection|nothing selected|select nothing)\b/i.test(raw)) {
      cmds.push({ action: "deselect" });
    }
    /* Building your own has to be able to start from nothing, and the toolbar
       has no button for it: every preset REPLACES the mechanism, so there was
       no way to ask for an empty canvas at all. */
    if (/\b(start (?:from )?(?:scratch|over|fresh|empty)|blank canvas|empty canvas|clear the (?:canvas|board|mechanism)|new mechanism|wipe it|delete everything)\b/i.test(raw) && !asking) {
      cmds.push({ action: "reset" });
    }

    /* "build a four-bar LINKAGE" names a mechanism; "build a bar" asks to join
       the selection. If a starter was matched in this clause the sentence was
       about that, so the second reading is dropped rather than both firing. */
    const namedAPreset = cmds.some((c) => c.action === "preset" || c.action === "generate");
    if (/\b(link|join|connect|tie)\b[^.]{0,20}?\b(them|these|it|those|selection|together|up|into a (?:bar|body|plate))\b/i.test(raw)
        || (!namedAPreset && !/\b(?:links?|bars?)\s+\d/i.test(raw)
            && /\b(make|build)\b[^.]{0,16}?\b(a )?(rigid )?(bar|body|plate|link)\b/i.test(raw))) {
      if (!asking) cmds.push({ action: "link" });
    }
    if (/\b(slider|slide|rail|prismatic)\b/i.test(raw) && !asking && !/\bscissor\b/i.test(raw)) {
      cmds.push({ action: "slide" });
    }
    /* An action that NAMES what it acts on selects it first. "Anchor joint 1"
       has to mean joint 1, not "anchor whatever happens to be selected" -- the
       difference is a crank with one fixed end and a bar with two, and the
       second one cannot take a motor at all. */
    const namesJoints = /\b(?:joints?|nodes?|points?)\s+\d/i.test(raw);
    const namesLink = /\b(?:links?|bars?)\s+\d/i.test(raw);
    const onNamed = (ids) => { if (ids.length) cmds.push({ action: "select", which: "ids", ids }); };

    /* Anchoring is a toggle, so "unanchor joint 3" and "anchor joint 3" run the
       same action and differ only in which state the joint was in. Both words
       are accepted because a suggestion chip has to say what it will actually
       do: offering "anchor joint 3" for a joint that is already anchored would
       read as the opposite of what pressing it does. */
    if (/\b(anchor|unanchor|un-anchor|free|ground|unground|pin (?:it|them) down|fix (?:it|them) in place)\b/i.test(raw) && !asking) {
      if (namesJoints) onNamed(picks);
      cmds.push({ action: "anchor" });
    }
    const generating = cmds.some((c) => c.action === "generate");
    if (/\b(motor|drive it|driven|crank it)\b/i.test(raw) && !asking && !generating
        && !FASTER.test(raw) && !SLOWER.test(raw)) {
      if (namesLink && picks.length) cmds.push({ action: "selectLink", n: picks[0] });
      cmds.push({ action: "motor" });
    }
    if (/\b(variable|change length|stretchy|extensible|telescop\w*)\b/i.test(raw) && !asking) {
      if (namesLink && picks.length) cmds.push({ action: "selectLink", n: picks[0] });
      cmds.push({ action: "variable" });
    }
    if (/\b(delete|remove|get rid of|erase)\b/i.test(raw) && !asking
        && !/\b(trace|traces|path|paths|trail|trails)\b/i.test(raw)) {
      cmds.push({ action: "delete" });
    }

    /* --- exports --- */
    if (/\b(blender)\b/i.test(raw) && !asking) cmds.push({ action: "export", what: "blender" });
    else if (/\b(stl|printable|3d ?print|parts)\b/i.test(raw) && !asking) cmds.push({ action: "export", what: "stl" });
    if (/\b(share|copy the link|link to this|permalink|send this)\b/i.test(raw) && !asking) {
      cmds.push({ action: "share" });
    }
    if (/\b(list|what joints|which joints|name the joints|joints are there)\b/i.test(raw)) {
      cmds.push({ action: "list" });
    }

    const grav = onOff(raw, "gravity");
    if (grav !== null || /\bgravity\b/i.test(raw)) {
      if (!asking) cmds.push({ action: "gravity", value: grav });
    }
    if (/\b(clear|erase|wipe|remove)\b.{0,16}\b(trace|traces|path|paths|trail|trails)\b/i.test(raw)) {
      cmds.push({ action: "clearTraces" });
    } else if (/\b(trace|traces|path|paths|trail)\b/i.test(raw) && !asking && /\b(trace|draw|show)\b/i.test(raw)) {
      if (/\b(?:joints?|nodes?|points?)\s+\d/i.test(raw)) {
        const ids = ordinals(raw);
        if (ids.length) cmds.push({ action: "select", which: "ids", ids });
      }
      cmds.push({ action: "trace" });
    }
    if (/\b(3d|three d|3 d|solid|perspective)\b/i.test(raw) && !asking) cmds.push({ action: "view", value: "3d" });
    else if (/\b(2d|design view|flat|editor|schematic|drawing)\b/i.test(raw) && !asking) cmds.push({ action: "view", value: "design" });

    if (FASTER.test(raw)) cmds.push({ action: "speed", delta: magnitude(raw) });
    else if (SLOWER.test(raw)) cmds.push({ action: "speed", delta: -magnitude(raw) });
    if (/\b(undo)\b/i.test(raw)) cmds.push({ action: "undo" });
  }

  /* "Full frame" is a sensor format, and FIT matches "frame". Without this the
     one phrase every photographer uses for a 36 mm sensor also reframed the
     3D view. */
  if (FIT.test(raw) && !asking && !/\bfull ?frame\b/i.test(raw)) cmds.push({ action: "fit" });

  /* Run and pause go last: a preset load stops the simulation, so asking for
     both in one sentence has to end with the run.

     Linkage only, and named rather than excluded. It used to read
     `domain !== "light"`, which was the same thing while there were two tools
     and silently wrong the moment there were three: "stop down to f/16" came
     back as an aperture change AND a request to pause a simulation the optics
     page does not have. Neither the light solver nor the optics renderer has
     anything to start or stop -- both re-render whenever something changes --
     and both have vocabulary that collides ("move it to...", "stop down"). */
  if (domain === "linkage") {
    if (PAUSE.test(raw) && !asking) cmds.push({ action: "pause" });
    else if (RUN.test(raw) && !asking && !/\brun(?:s|ning)? (?:in|on|entirely)\b/i.test(raw)) {
      /* "run" is also how people ask what a preset IS ("what does the quick
         return do when you run it"), which ASKING already caught. */
      cmds.push({ action: "run" });
    }
  }

  /* A lone "run" with a preset in the same breath is the preset's run, and a
     lone preset with no verb at all is still a load. Nothing else survives. */
  return dedupe(cmds);
}

/* Overlapping patterns can push the same command twice from one clause. Keyed
   on the whole command, not just its name, so "place a joint at 0 0" and
   "place a joint at 60 0" are never mistaken for a repeat. */
function dedupe(cmds) {
  const seen = new Set();
  const out = [];
  for (const c of cmds) {
    const key = JSON.stringify(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
