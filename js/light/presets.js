/* Starter scenes, written in the same format the C CLI reads.

   The workcell is first because it is the one this engine was built for: a work
   surface under a 2x2 LED array inside a white enclosure, which is the geometry
   behind the adaptive-lighting patent and thesis. It shows the three things a
   closed-form cos(theta)/r^2 model cannot -- shadowing, interreflection off the
   enclosure, and a real spectral source. */

export const PRESETS = [
  {
    id: "workcell",
    name: "Inspection workcell",
    blurb: "A work surface under a 2×2 LED array inside a white enclosure. Shows shadowing, interreflection off the walls, and a real spectral source at once.",
    text: `# A work surface lit by a 2x2 array of LED panels inside a white enclosure.
material floor  lambert 0.20
material wall   lambert 0.80
material part   lambert 0.50

# Enclosure, 0.6 x 0.6 x 0.5 m, open toward -y so you can see in.
quad floor  0     0     0.0    0  0  1    0.3 0 0     0 0.3 0
quad wall   0     0     0.5    0  0 -1    0.3 0 0     0 0.3 0
quad wall  -0.3   0     0.25   1  0  0    0 0.3 0     0 0 0.25
quad wall   0.3   0     0.25  -1  0  0    0 0.3 0     0 0 0.25
quad wall   0     0.3   0.25   0 -1  0    0.3 0 0     0 0 0.25

# 2x2 array of 200 lm neutral-white panels facing down.
light rect -0.12 -0.12 0.45   0.05 0 0   0 -0.05 0   lm 200 daylight 5000
light rect  0.12 -0.12 0.45   0.05 0 0   0 -0.05 0   lm 200 daylight 5000
light rect -0.12  0.12 0.45   0.05 0 0   0 -0.05 0   lm 200 daylight 5000
light rect  0.12  0.12 0.45   0.05 0 0   0 -0.05 0   lm 200 daylight 5000

# A part held above the surface, casting a soft shadow.
sphere part  0.06  0.02  0.09   0.05

grid -0.3 -0.3 0.001    0.6 0 0    0 0.6 0    64 64
`,
  },
  {
    id: "single-panel",
    name: "One panel, bare surface",
    blurb: "A single panel over an open surface, with no walls to bounce light back. The cleanest way to see inverse-square falloff and the cosine law on their own.",
    text: `material floor lambert 0.20

quad floor 0 0 0   0 0 1   0.4 0 0   0 0.4 0

light rect 0 0 0.4   0.06 0 0   0 -0.06 0   lm 400 daylight 5000

grid -0.4 -0.4 0.001   0.8 0 0   0 0.8 0   64 64
`,
  },
  {
    id: "spot",
    name: "Spot on a curved part",
    blurb: "A tungsten spot raking across a sphere. The cone falloff and the shadow it throws are what a glare or contrast study is really about.",
    text: `material floor lambert 0.35
material part  lambert 0.55

quad floor 0 0 0   0 0 1   0.3 0 0   0 0.3 0
sphere part 0 0 0.06   0.06

light spot -0.2 -0.2 0.35   0.5 0.5 -0.8   35 22   W 6 blackbody 3000

grid -0.3 -0.3 0.001   0.6 0 0   0 0.6 0   64 64
`,
  },
  {
    id: "two-source",
    name: "Warm and cool together",
    blurb: "A 2700 K panel against a 6500 K one. Same lumens, different spectra: switch to W·m⁻² and the balance between them changes.",
    text: `material floor lambert 0.25
material wall  lambert 0.70

quad floor 0 0 0     0 0 1    0.3 0 0   0 0.3 0
quad wall  0 0.3 0.2  0 -1 0   0.3 0 0   0 0 0.2

light rect -0.15 0 0.35   0.05 0 0   0 -0.05 0   lm 300 blackbody 2700
light rect  0.15 0 0.35   0.05 0 0   0 -0.05 0   lm 300 daylight 6500

grid -0.3 -0.3 0.001   0.6 0 0   0 0.6 0   64 64
`,
  },
  {
    id: "sun",
    name: "Daylight through an opening",
    blurb: "A directional source at a low angle, with a wall casting a hard shadow. A sun is a delta direction, so its shadow has no penumbra at all.",
    text: `material ground lambert 0.30
material wall   lambert 0.60

quad ground 0 0 0    0 0 1    0.5 0 0   0 0.5 0
quad wall   0 0.1 0.15   0 -1 0   0.15 0 0   0 0 0.15

light sun 0.5 0.6 -0.62   120 daylight 6504

grid -0.5 -0.5 0.001   1 0 0   0 1 0   64 64
`,
  },
];

export const presetById = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];
