// ============================================================
// FSR DRUM GLOVE - a simple loop-based looper
// ============================================================
// How it works, in plain terms:
// 1. Press the FSR glove sensor -> that plays a note. Press harder = the
//    pitch bends up (a smooth glide, not steps) - see forceToBendSemitones()
//    for the exact curve. Keep holding it down = the note keeps sounding
//    until you let go, and the bend keeps tracking your pressure the whole
//    time - both live and when it's played back later.
// 2. Click "Record" to record your first pass. Click it again to stop -
//    however long that took becomes your LOOP LENGTH. Every future
//    recording will loop at that same length.
// 3. Click "Record" (it now says "Overdub") any time to add ANOTHER layer
//    on top, synced to the loop that's already playing. That's how you
//    build up a whole song out of separate layers.
// 4. After recording, each note is drawn as a LINE GRAPH, not a block: a
//    row of connected dots, one roughly every half-beat, whose HEIGHT is
//    the actual pitch sounding at that instant (your chosen note plus
//    whatever bend you were pressing). A gap with no line/dots is silence.
//    The line's COLOR is also pitch, not instrument: red at C, fading
//    through purple up to blue at B, wrapping every octave - see
//    colorForSemitones() below.
//    - Drag any single dot to reshape the pitch at that instant, or drag
//      the very first/last dot past the note's current edge to extend or
//      shorten it - there's no separate "stretch handle" anymore, the dots
//      themselves are the handles.
//    - Click-drag the connecting LINE (not a dot) to move the whole note -
//      shifts it in time and pitch together, keeping its shape. Shift-click
//      a note to add/remove it from a multi-selection, or drag an empty
//      patch of background to rubber-band a whole box of notes, and drag
//      any of them to move the group together.
//    - Ctrl/Cmd+C copies, +X cuts, +V pastes starting at the position bar.
//    - The position bar (the vertical line) tracks playback, but you can
//      also drag its little flag, or click empty background, to move it
//      yourself - that's where paste and Split both work from.
//    - "Split" (button or the S key) turns clicks into cuts: click
//      anywhere at the time you want and it slices every note there.
//    - Undo/Redo cover recording, deleting, moving, quantizing, splitting,
//      cutting and pasting.
//    - "Quantize" snaps every note's start to the nearest beat of the tempo
//      grid (4/4 only, for now) - it doesn't reshape the pitch curve itself.
// ============================================================


// ---------- Serial connection to the Arduino ----------
let serialPort = null;
let incomingText = ""; // holds any partial line between reads

// ---------- Sensor state ----------
// The Arduino's ADC can technically report 0-1023, but this specific glove's
// FSR + resistor combo physically tops out around 400 under a real hard
// press - values above that just don't happen, so the "usable" range for
// every mapping below is PRESS_THRESHOLD (10) to FORCE_MAX (400), not the
// theoretical 0-1023.
let forceValue = 0;          // most recent raw reading from the FSR (0-1023 theoretical, ~0-400 in practice)
let smoothedForce = 0;       // forceValue, lightly smoothed (see draw()) - what the live pitch bend actually reacts to
let isPressed = false;       // is the sensor currently pressed past the threshold (using the smoothed reading)
const PRESS_THRESHOLD = 10;  // raw value that counts as "you're pressing it"
const FORCE_MAX = 400;       // raw value treated as "as hard as this glove can register" - the top of every force mapping

// How quickly the smoothed reading follows the raw one, from 0 (frozen) to
// 1 (no smoothing at all). The FSR's raw values wobble a little sample to
// sample - feeding that straight into the oscillator's pitch would make the
// bend jitter instead of glide smoothly. Smoothing the reading first fixes
// that at the source, before it ever reaches the oscillator.
const FORCE_SMOOTHING = 0.35;
let lastLiveFreqSet = -1; // the last frequency actually sent to liveOsc.freq() - lets us skip re-sending changes too small to hear

// Volume is fixed now that force drives the pitch bend instead - one input,
// one job. 1.0 = full volume (still shaped by each instrument's attack/release).
const FIXED_VELOCITY = 1.0;

// How many milliseconds to shift a recorded note's start time by, to
// compensate for any residual lag between physically pressing the sensor
// and it registering here (serial polling + the browser's draw loop).
// Bigger values shift recorded notes EARLIER. Tunable live via the
// "Latency comp" field in the toolbar.
let inputLatencyMs = 0;

// ---------- What you're currently set to play ----------
let currentInstrument = "pluck"; // "pluck", "pad", or "bass"
let currentPitchIndex = 0;       // 0-7, an index into PITCH_FREQUENCIES/SCALE_SEMITONES

// A simple 8-note major scale (C4 up to C5). Keys 1-8 pick these in order.
const PITCH_FREQUENCIES = [
  261.63, // C4
  293.66, // D4
  329.63, // E4
  349.23, // F4
  392.00, // G4
  440.00, // A4
  493.88, // B4
  523.25  // C5
];

// Note letter names, lined up with PITCH_FREQUENCIES above - just for
// labeling the on-screen buttons (and the graph's reference lines) so you
// know which number/height is which note.
const PITCH_NAMES = ["C", "D", "E", "F", "G", "A", "B", "C"];

// Every note's actual pitch is tracked as a semitone offset from C4 (0 =
// C4), rather than "which of the 8 scale steps." Derived from
// PITCH_FREQUENCIES itself (instead of hand-typing [0,2,4,5,7,9,11,12]) so
// the two can never drift out of sync with each other.
const SCALE_SEMITONES = PITCH_FREQUENCIES.map((f) => Math.round(12 * Math.log2(f / PITCH_FREQUENCIES[0])));

// ---------- Tempo grid ----------
// Only 4/4 is supported right now (4 beats per measure) - the plan is to
// add a time-signature picker later, but the grid math below is already
// written generically off BEATS_PER_MEASURE so that's a small change when
// it happens.
let bpm = 120;
const BEATS_PER_MEASURE = 4;

function beatIntervalMs() {
  return 60000 / bpm;
}

// One simple "recipe" per instrument: the oscillator waveform, how fast the
// note fades IN when you press (attack), how fast it fades OUT after you
// let go (release), and the color it's drawn with in the recording view.
const INSTRUMENTS = {
  pluck: { waveform: "triangle", attack: 0.015, release: 0.15, color: [92, 197, 224] },  // soft sky-teal
  pad:   { waveform: "sine",     attack: 0.25,  release: 0.6,  color: [176, 141, 255] }, // soft lavender
  bass:  { waveform: "square",   attack: 0.03,  release: 0.3,  color: [255, 143, 110] }  // soft coral
};

// ---------- Per-note color, by pitch ----------
// Note lines used to be a flat color per instrument. Now every note's line
// is colored by its PITCH instead: C is red, B is blue, and everything in
// between blends smoothly through purple - a straight-line fade from red to
// blue in RGB space naturally passes through purple at the midpoint, which
// is all this needs. It wraps every octave (12 semitones) so C5 reads as
// the same red as C4, rather than fading back down from blue.
const PITCH_COLOR_LOW = [224, 64, 84];   // red, for C (and every C above/below it)
const PITCH_COLOR_HIGH = [70, 96, 226];  // blue, for B (the top of the octave)

function colorForSemitones(semitones) {
  const posInOctave = ((semitones % 12) + 12) % 12; // 0 (C) .. 11 (B)
  const t = posInOctave / 11; // 11, not 12, so B itself actually reaches pure blue
  return [
    lerp(PITCH_COLOR_LOW[0], PITCH_COLOR_HIGH[0], t),
    lerp(PITCH_COLOR_LOW[1], PITCH_COLOR_HIGH[1], t),
    lerp(PITCH_COLOR_LOW[2], PITCH_COLOR_HIGH[2], t)
  ];
}

// Draws one line segment with its color fading smoothly between the two
// endpoints' pitch colors, instead of a single flat stroke color - this is
// what makes a note's line read as a continuous color gradient rather than
// blocky per-segment colors when its pitch is bending.
// c1/c2 are [r, g, b] or [r, g, b, alpha] - alpha defaults to fully opaque
// when omitted, so callers that don't need fading can skip it.
const GRADIENT_STEPS = 10;
function strokeGradientLine(x1, y1, c1, x2, y2, c2) {
  const a1 = c1.length > 3 ? c1[3] : 255;
  const a2 = c2.length > 3 ? c2[3] : 255;
  for (let s = 0; s < GRADIENT_STEPS; s++) {
    const t0 = s / GRADIENT_STEPS;
    const t1 = (s + 1) / GRADIENT_STEPS;
    const tm = (t0 + t1) / 2; // sample the color at the segment's midpoint
    stroke(lerp(c1[0], c2[0], tm), lerp(c1[1], c2[1], tm), lerp(c1[2], c2[2], tm), lerp(a1, a2, tm));
    line(lerp(x1, x2, t0), lerp(y1, y2, t0), lerp(x1, x2, t1), lerp(y1, y2, t1));
  }
}

// ---------- The "live" voice ----------
// This is the ONE oscillator that actually makes sound when you press the
// FSR in real time. We only need one, because you can only press the
// sensor with one hand at a time.
let liveOsc;
let noteStartTime = 0;         // millis() timestamp when the current press began
let liveNoteBaseSemitones = 0; // the current note's plain (unbent) pitch, as a semitone offset from C4
let liveCurve = [];            // {t, semitones} samples of the ACTUAL pitch (base + bend) across the current hold, captured for recording

// While you're recording and currently holding the sensor down, this is
// where (on the loop timeline) that in-progress note started - used to
// draw a live growing preview of it before it's actually finished.
let liveNoteRecordStart = null;

// ---------- Recording / looping state ----------
let isRecording = false;
let isPlaying = false;
let loopLength = null;       // length of the loop in milliseconds (set by your first recording)
let loopStartTime = 0;       // millis() that the loop timing is measured from
let recordStartTime = 0;     // millis() when the current recording pass began
let currentTakeNotes = [];   // notes captured during the recording pass happening right now

// Each finished recording pass becomes one "track" (one layer).
// A track is just: { notes: [ ...note objects... ] }
// A note object looks like:
//   { startTime, duration, instrument, velocity, curve, hasStarted, hasEnded }
// startTime and duration are both in milliseconds, measured from the loop
// start. curve is the note's pitch graph: a list of { t, semitones }
// breakpoints, t relative to the note's own startTime (0..duration) and
// semitones an ABSOLUTE offset from C4 - this one curve is both "which
// note" and "how it bends," there's no separate pitchIndex anymore.
// Notes are colored by PITCH (see colorForSemitones above), not by
// instrument or track - a straight red-to-blue gradient across the octave -
// so you can tell at a glance how a note's pitch moves and bends, across
// every layer.
let tracks = [];

// While the loop plays, each TRACK gets its OWN oscillator to play its
// notes back. (Again: one hand, one note at a time per track, so one
// oscillator per track is all we need - no complicated "voice pool.")
let playbackVoices = []; // playbackVoices[trackIndex] = { osc, lastFreqSet }

// ---------- Dragging notes/points, and the position bar ----------
let draggedNote = null;   // the note currently being reshaped or moved
let dragMode = null;      // "point" (dragging one breakpoint) | "move" (dragging the whole note/selection) | null
let dragPointIndex = -1;  // which index into draggedNote.curve is being dragged, when dragMode === "point"
let dragStartMouseX = 0;  // mouseX/Y when a "move" drag began
let dragStartMouseY = 0;
let dragGroupStart = [];  // snapshot of every selected note's startTime/curve when a "move" drag began, so the whole selection drags as one rigid block

let draggingCursor = false; // true while dragging the position bar's little handle
const CURSOR_HANDLE_HEIGHT = 10; // px tall, the grabbable flag above the position bar

// Whichever note the mouse is currently hovering (for the "move" cursor)
// and whichever single point it's close enough to grab (for reshaping).
let hoveredNote = null;
let hoveredPoint = null; // { note, index }

const POINT_HIT_RADIUS = 9;  // px - how close the mouse must be to a dot to grab it
const LINE_HIT_RADIUS = 6;   // px - how close the mouse must be to a note's line (away from any dot) to move the whole note
const MIN_NOTE_DURATION = 60; // never let editing leave a note shorter than this (ms)
const MIN_POINT_GAP = 15;     // never let two of a note's breakpoints get closer together than this (ms)

// The graph's vertical range, in semitones from C4. A little headroom below
// the lowest scale note and above the highest possible bend (C5 + max bend).
const GRAPH_SEMITONE_MIN = -3;
const GRAPH_SEMITONE_MAX = SCALE_SEMITONES[SCALE_SEMITONES.length - 1] + 9; // BEND_MAX_SEMITONES (below) + a little headroom

// Piano-roll drawing area (set once per frame in drawPianoRoll, used by
// the mouse functions too so dragging lines up with what's drawn).
let rollX, rollY, rollWidth, rollHeight;

// The length (in ms) the piano roll is currently scaled to. Once you have
// a real loop length this is just that. While your very first recording
// pass is still going (before a loop length exists yet), this instead
// grows automatically so you get a live preview immediately.
let scaleLength = null;

// The position bar's location on the loop timeline (ms). It tracks
// playback while playing, freezes wherever it was when you stop, and can
// be dragged or clicked to any spot - which is also where paste and Split
// both anchor from.
let editCursorTime = 0;


// ============================================================
// p5.js setup / draw
// ============================================================

function setup() {
  const canvas = createCanvas(canvasWidth(), 280);
  canvas.parent("sketch-holder");

  // Set up the one live voice used for playing the FSR in real time.
  liveOsc = new p5.Oscillator("triangle");
  liveOsc.amp(0);
  liveOsc.start();

  // Browsers refuse to make ANY sound until the page has seen a real user
  // gesture (a click, tap, or keypress) - an anti-autoplay policy, nothing
  // to do with this app. p5.sound usually unlocks itself on the first
  // click, but which click actually counts can be inconsistent (a native
  // dialog, like the serial port picker Connect Arduino opens, sometimes
  // doesn't count as "the" gesture). Do it explicitly instead: the very
  // first click or keypress anywhere on the page unlocks audio right away,
  // so pressing the FSR works immediately rather than only after you
  // happen to have clicked some button that counted.
  const unlockAudio = () => {
    userStartAudio();
    document.removeEventListener("click", unlockAudio);
    document.removeEventListener("keydown", unlockAudio);
  };
  document.addEventListener("click", unlockAudio);
  document.addEventListener("keydown", unlockAudio);

  buildPitchButtons();
  hookUpButtons();
  updateTransportButtonLabels();
}

// How wide the canvas should be: the full browser window, minus the same
// left/right gutter the rest of the page uses (see body's padding in
// style.css), so the recording view fills the screen edge-to-edge.
function canvasWidth() {
  return max(320, windowWidth - 48);
}

function windowResized() {
  resizeCanvas(canvasWidth(), 280);
}

function draw() {
  background(250, 248, 244); // soft off-white, matching the page around it
  smoothedForce += (forceValue - smoothedForce) * FORCE_SMOOTHING;
  updateForceMeterDisplay();
  handleSensorInput();
  updatePlayback();
  drawPianoRoll();
}


// ============================================================
// Reading the sensor + playing the live note
// ============================================================

function handleSensorInput() {
  const nowPressed = smoothedForce > PRESS_THRESHOLD;

  if (nowPressed && !isPressed) {
    startLiveNote();          // you just pressed down
  } else if (nowPressed && isPressed) {
    updateLiveNotePitch();    // you're still holding it - force bends the pitch
  } else if (!nowPressed && isPressed) {
    stopLiveNote();           // you just let go
  }

  isPressed = nowPressed;
}

// ---------- Force -> pitch bend mapping ----------
// Pressing harder bends the note's pitch UP - never down - as a smooth
// glide the whole way, not stepped jumps. At/below FORCE_BEND_START the
// note plays at its plain pitch; from there up to FORCE_MAX the bend rises
// linearly to BEND_MAX_SEMITONES: +2 semitones (a whole tone) at 200, +4 at
// 300, +6 at 400 - each 100-unit checkpoint adds one more whole tone, and
// everything between checkpoints glides continuously rather than snapping.
const FORCE_BEND_START = 100;   // raw force where the bend starts (at/below this: no bend)
const BEND_MAX_SEMITONES = 6;   // semitone offset reached at FORCE_MAX (three whole tones)

function forceToBendSemitones(force) {
  if (force <= FORCE_BEND_START) return 0;
  return constrain(map(force, FORCE_BEND_START, FORCE_MAX, 0, BEND_MAX_SEMITONES), 0, BEND_MAX_SEMITONES);
}

// Standard equal-temperament conversion: each semitone is a 12th-root-of-2
// step, so this turns a semitone-from-C4 offset into an actual frequency.
function freqForSemitones(semitones) {
  return PITCH_FREQUENCIES[0] * Math.pow(2, semitones / 12);
}

// A note's pitch curve is a sparse list of {t, semitones} breakpoints (t =
// ms since the note started, semitones = absolute offset from C4). These
// helpers keep that curve correct whenever a note's timing changes -
// clipped when a note is shortened, and read back with interpolation
// during playback, drawing, and when splitting needs the value at some
// exact instant.

// Piecewise-linear lookup: the value at any moment between whichever two
// breakpoints bracket it. Before the first or after the last, just holds
// that end's value - and an empty/missing curve (e.g. a note loaded from
// an older save file, before this feature existed) is treated as silent/flat.
function interpolatePitchCurve(curve, t) {
  if (!curve || curve.length === 0) return 0;
  if (t <= curve[0].t) return curve[0].semitones;
  if (t >= curve[curve.length - 1].t) return curve[curve.length - 1].semitones;

  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i], b = curve[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const amount = span > 0 ? (t - a.t) / span : 0;
      return lerp(a.semitones, b.semitones, amount);
    }
  }
  return curve[curve.length - 1].semitones;
}

function clonePitchCurve(curve) {
  return (curve || []).map((sample) => ({ t: sample.t, semitones: sample.semitones }));
}

// Trims a curve to a new (shorter) duration, adding an interpolated point
// right at the cutoff so the last instant of the shortened note still holds
// the right pitch instead of snapping to whichever breakpoint was nearest.
function clipPitchCurve(curve, newDuration) {
  if (!curve || curve.length === 0) return [];
  const valueAtCut = interpolatePitchCurve(curve, newDuration);
  const trimmed = curve.filter((sample) => sample.t < newDuration);
  trimmed.push({ t: newDuration, semitones: valueAtCut });
  return trimmed;
}

// Downsamples a raw, densely-sampled live curve (captured once per draw()
// frame, ~60/sec) down to roughly one breakpoint per half-beat, so what you
// get to edit afterward is a manageable row of dots instead of hundreds of
// them. Always keeps the exact first and last instants.
function resamplePitchCurve(rawCurve, duration) {
  if (!rawCurve || rawCurve.length === 0) {
    return [{ t: 0, semitones: 0 }, { t: max(duration, 1), semitones: 0 }];
  }
  // Never fewer than ~60ms between dots even at very fast tempos, so a
  // short note doesn't still end up as a wall of overlapping points.
  const step = max(60, beatIntervalMs() / 2);
  const points = [];
  for (let t = 0; t < duration; t += step) {
    points.push({ t: t, semitones: interpolatePitchCurve(rawCurve, t) });
  }
  points.push({ t: duration, semitones: interpolatePitchCurve(rawCurve, duration) });
  return points;
}

function startLiveNote() {
  const recipe = INSTRUMENTS[currentInstrument];
  liveNoteBaseSemitones = SCALE_SEMITONES[currentPitchIndex];

  const initialSemitones = liveNoteBaseSemitones + forceToBendSemitones(smoothedForce);
  const initialFreq = freqForSemitones(initialSemitones);
  liveOsc.setType(recipe.waveform);
  liveOsc.freq(initialFreq);
  lastLiveFreqSet = initialFreq;
  liveCurve = [{ t: 0, semitones: initialSemitones }];

  // Ramp up smoothly from whatever the volume already is (normally ~0,
  // since the previous note finished releasing). We used to force it to
  // exactly 0 first with a 0-length ramp - two volume changes scheduled
  // at the same instant is what was causing the "click" on every press.
  liveOsc.amp(FIXED_VELOCITY, recipe.attack);

  noteStartTime = millis();
  if (isRecording) {
    liveNoteRecordStart = currentTimelineTime();
  }
}

function updateLiveNotePitch() {
  const semitones = liveNoteBaseSemitones + forceToBendSemitones(smoothedForce);
  const freq = freqForSemitones(semitones);

  // Only actually resend the frequency when the change is big enough to
  // matter (see FORCE_SMOOTHING above) - the same idea as an old volume
  // click-fix, applied to pitch instead.
  //
  // IMPORTANT: no ramp time here. Passing one makes p5.sound schedule the
  // change with exponentialRampToValueAtTime under the hood, which has no
  // cancelScheduledValues/anchor safety net - when the target reverses
  // direction rapidly (press up, back down, up again - exactly what
  // bending pitch by feel does), it can throw, which freezes the whole
  // draw loop (audio, playback and sensor handling all stop - "goes
  // silent" is the symptom). Calling freq() with just the value uses a
  // plain, safe setValueAtTime instead. We don't lose the glide feel: this
  // already runs every frame (~60/sec) against an already-smoothed input
  // (FORCE_SMOOTHING), so the glide comes from that, not from an
  // audio-node-level ramp.
  if (abs(freq - lastLiveFreqSet) > 0.5) {
    liveOsc.freq(freq);
    lastLiveFreqSet = freq;
  }

  if (isRecording && liveNoteRecordStart !== null) {
    liveCurve.push({ t: millis() - noteStartTime, semitones: semitones });
  }
}

function stopLiveNote() {
  const recipe = INSTRUMENTS[currentInstrument];
  liveOsc.amp(0, recipe.release);
  lastLiveFreqSet = -1;

  const duration = millis() - noteStartTime;
  // Pass along the timeline position captured back when the press STARTED
  // (see startLiveNote) - not "now". Calling currentTimelineTime() here
  // instead would evaluate at RELEASE time, shifting every note forward by
  // its own hold length.
  recordNoteIfRecording(liveNoteRecordStart, duration, liveCurve);
  liveNoteRecordStart = null;
  liveCurve = [];
}

function recordNoteIfRecording(startTime, duration, rawCurve) {
  if (!isRecording || startTime === null) return;

  // Fine-tune with the small manual offset too (see inputLatencyMs above),
  // wrapping/clamping back into the loop as needed.
  let adjustedStart = startTime - inputLatencyMs;
  adjustedStart = loopLength
    ? ((adjustedStart % loopLength) + loopLength) % loopLength
    : max(0, adjustedStart);

  const note = {
    startTime: adjustedStart,
    duration: duration,
    instrument: currentInstrument,
    velocity: FIXED_VELOCITY,
    curve: resamplePitchCurve(rawCurve, duration),
    hasStarted: false,
    hasEnded: false
  };

  // Don't let a note run past the end of the loop - just clip it (and its
  // pitch curve along with it).
  if (loopLength && note.startTime + note.duration > loopLength) {
    note.duration = loopLength - note.startTime;
    note.curve = clipPitchCurve(note.curve, note.duration);
  }

  currentTakeNotes.push(note);
}

// Where are we in the loop right now, in milliseconds?
function currentTimelineTime() {
  if (loopLength) {
    return (millis() - loopStartTime) % loopLength;
  }
  // No loop length yet - this is the very first recording pass, so just
  // measure plainly from when Record was pressed.
  return millis() - recordStartTime;
}


// ============================================================
// Recording / overdubbing / playback control
// ============================================================

function toggleRecord() {
  if (!isRecording) {
    isRecording = true;
    currentTakeNotes = [];
    recordStartTime = millis();

    if (!loopLength) {
      loopStartTime = millis(); // first pass - loop timing starts now
    }
  } else {
    isRecording = false;

    if (!loopLength) {
      // This first pass just defined how long the loop is.
      loopLength = millis() - recordStartTime;
      if (loopLength < 500) loopLength = 500; // safety minimum
    }

    pushUndoSnapshot(); // so a take you don't like can be undone
    addTrack(currentTakeNotes);
    isPlaying = true; // start looping automatically once there's something to hear
  }

  updateTransportButtonLabels();
}

function togglePlay() {
  if (!loopLength) return; // nothing recorded yet
  isPlaying = !isPlaying;

  if (isPlaying) {
    // Pick the loop back up from wherever the position bar is, instead of
    // jumping back to the very start.
    loopStartTime = millis() - editCursorTime;
  } else {
    // Stopping mid-note used to leave whatever was sounding stuck at full
    // volume forever - updatePlayback() is the only thing that ever calls
    // stopTrackNote(), and it stops running the instant isPlaying goes
    // false, so a note that was mid-flight never got told to release.
    // Cut every voice off right here instead.
    playbackVoices.forEach((voice) => voice.osc.amp(0, 0.05));
  }

  updateTransportButtonLabels();
}

function clearAll() {
  pushUndoSnapshot();

  isRecording = false;
  isPlaying = false;
  loopLength = null;
  currentTakeNotes = [];
  editCursorTime = 0;

  playbackVoices.forEach((voice) => voice.osc.amp(0, 0.05));
  tracks = [];
  playbackVoices = [];
  clearSelection();

  updateTransportButtonLabels();
  refreshTrackListUI();
}

function addTrack(notes) {
  tracks.push({ notes: notes });

  const osc = new p5.Oscillator("sine");
  osc.amp(0);
  osc.start();
  playbackVoices.push({ osc: osc, lastFreqSet: 0 });

  refreshTrackListUI();
}

function clearTrack(index) {
  pushUndoSnapshot();

  const removedTrack = tracks[index];
  removedTrack.notes = [];
  selectedNotes = selectedNotes.filter((entry) => entry.track !== removedTrack);

  refreshTrackListUI();
}

function deleteSelectedNotes() {
  if (selectedNotes.length === 0) return;

  pushUndoSnapshot();
  selectedNotes.forEach(({ note, track }) => {
    const i = track.notes.indexOf(note);
    if (i !== -1) track.notes.splice(i, 1);
  });

  clearSelection();
  refreshTrackListUI();
}

// "Tempo correct": snaps every recorded note (across every track) to
// whichever tempo-grid beat line it's currently closest to, keeping its
// duration and pitch curve shape the same (curve is stored relative to
// startTime, so it comes along for free; just clipped if the new position
// would now run past the loop end).
function quantizeAllNotes() {
  if (!loopLength) return;
  const beatMs = beatIntervalMs();
  if (!beatMs || beatMs <= 0) return;

  pushUndoSnapshot();

  tracks.forEach((track) => {
    track.notes.forEach((note) => {
      const nearestBeat = round(note.startTime / beatMs) * beatMs;
      const snapped = ((nearestBeat % loopLength) + loopLength) % loopLength;

      note.startTime = snapped;
      if (note.startTime + note.duration > loopLength) {
        note.duration = loopLength - note.startTime;
        note.curve = clipPitchCurve(note.curve, note.duration);
      }
    });
  });
}

function updatePlayback() {
  if (!loopLength || !isPlaying) return;

  const playheadTime = currentTimelineTime();
  const justLooped = playheadTime < editCursorTime; // wrapped back to the start

  tracks.forEach((track, trackIndex) => {
    const voice = playbackVoices[trackIndex];

    track.notes.forEach((note) => {
      if (justLooped) {
        note.hasStarted = false;
        note.hasEnded = false;
      }

      const noteEndTime = note.startTime + note.duration;

      if (!note.hasStarted && playheadTime >= note.startTime) {
        playTrackNote(voice, note);
        note.hasStarted = true;
      }

      if (note.hasStarted && !note.hasEnded) {
        if (playheadTime >= noteEndTime) {
          stopTrackNote(voice, note);
          note.hasEnded = true;
        } else {
          // Keep replaying the recorded pitch curve for as long as the
          // note is sounding, not just at its start - this is what makes a
          // played-back note glide the same way it did when it was
          // recorded, instead of playing back flat.
          updateTrackNotePitch(voice, note, playheadTime - note.startTime);
        }
      }
    });
  });

  editCursorTime = playheadTime;
}

function playTrackNote(voice, note) {
  const recipe = INSTRUMENTS[note.instrument];

  // If the previous note on this track is still fading out - easy to
  // happen, since a pad's release (0.6s) can outlast the gap to the next
  // note even when nothing overlapped when you actually played it live -
  // changing freq() out from under that fade bends its tail into the new
  // pitch. That's what was making playback sound choppy/warbly even
  // though the recording itself was clean. Cut it off cleanly first, then
  // start the new note's attack right after.
  voice.osc.amp(0, 0.01);
  voice.osc.setType(recipe.waveform);

  const semitonesAtStart = interpolatePitchCurve(note.curve, 0);
  const freq = freqForSemitones(semitonesAtStart);
  voice.osc.freq(freq);
  voice.lastFreqSet = freq;

  voice.osc.amp(note.velocity, recipe.attack, 0.01);
}

// Called every frame a recorded note is mid-flight during playback - reads
// the note's recorded pitch curve at the current position and re-aims the
// oscillator's frequency there, the same way updateLiveNotePitch() does for
// the live voice while you're actually holding the sensor.
function updateTrackNotePitch(voice, note, elapsed) {
  const semitones = interpolatePitchCurve(note.curve, elapsed);
  const freq = freqForSemitones(semitones);

  // No ramp time here - see the long comment in updateLiveNotePitch() for
  // why: an audio-node-level ramp on a rapidly reversing target is what was
  // causing playback to go silent.
  if (abs(freq - voice.lastFreqSet) > 0.5) {
    voice.osc.freq(freq);
    voice.lastFreqSet = freq;
  }
}

function stopTrackNote(voice, note) {
  const recipe = INSTRUMENTS[note.instrument];
  voice.osc.amp(0, recipe.release);
}


// ============================================================
// Drawing the piano-roll (now a continuous pitch line graph)
// ============================================================

// Works out what length (in ms) the piano roll should currently be scaled
// to. Normally that's just the fixed loop length. But during your very
// first recording pass - before a loop length even exists yet - we still
// want to show live feedback, so the timeline grows as you go.
function getScaleLength() {
  if (loopLength) return loopLength;
  if (isRecording) return max(2000, (millis() - recordStartTime) + 1000);
  return null;
}

// ---------- Coordinate mapping ----------
function timeToX(t) {
  return rollX + (t / scaleLength) * rollWidth;
}

function semitonesToY(semitones) {
  const amount = (semitones - GRAPH_SEMITONE_MIN) / (GRAPH_SEMITONE_MAX - GRAPH_SEMITONE_MIN);
  return rollY + (1 - amount) * rollHeight; // higher pitch = higher on screen
}

function yToSemitones(y) {
  const amount = 1 - (y - rollY) / rollHeight;
  return GRAPH_SEMITONE_MIN + amount * (GRAPH_SEMITONE_MAX - GRAPH_SEMITONE_MIN);
}

function yDeltaToSemitoneDelta(dy) {
  return -dy * (GRAPH_SEMITONE_MAX - GRAPH_SEMITONE_MIN) / rollHeight;
}

// The screen position of every breakpoint in a note's curve, in order.
function notePoints(note) {
  return note.curve.map((p) => ({ x: timeToX(note.startTime + p.t), y: semitonesToY(p.semitones) }));
}

function drawPianoRoll() {
  rollX = 20;
  rollY = 20;
  rollWidth = width - 40;
  rollHeight = height - 40;
  scaleLength = getScaleLength();

  noStroke();
  fill(255, 255, 255, 210); // frosted-glass panel, matching the toolbars around it
  rect(rollX, rollY, rollWidth, rollHeight, 14);

  if (!scaleLength) {
    fill(140, 148, 163);
    textAlign(CENTER, CENTER);
    text("Record a first pass to set the loop length", width / 2, height / 2);
    cursor(ARROW);
    return;
  }

  updateHoverState();

  // One horizontal reference line + label per scale note (C4 up to C5) -
  // these are just guides now, not rigid rows: a note's actual pitch can
  // sit anywhere between or above them once it's bent.
  stroke(232, 228, 221);
  SCALE_SEMITONES.forEach((s) => {
    const y = semitonesToY(s);
    line(rollX, y, rollX + rollWidth, y);
  });
  noStroke();

  fill(170, 176, 188);
  textSize(10);
  textAlign(RIGHT, CENTER);
  SCALE_SEMITONES.forEach((s, i) => {
    text(PITCH_NAMES[i], rollX - 6, semitonesToY(s));
  });
  textAlign(LEFT, BASELINE); // reset to p5's defaults for anything drawn after this

  drawTempoGrid();

  tracks.forEach((track) => {
    track.notes.forEach((note) => drawNote(note));
  });

  drawLiveNotePreview();
  drawEditCursor();
  drawMarquee();
}

// While you're recording AND currently holding the sensor down, draw a
// glowing preview of the note's pitch line as it grows, so you get instant
// feedback instead of only seeing it once you let go.
function drawLiveNotePreview() {
  if (!isRecording || !isPressed || liveNoteRecordStart === null || liveCurve.length === 0) return;

  const pulse = 170 + 70 * sin(millis() * 0.012); // gentle glow so it reads as "still going"

  const pts = liveCurve.map((p) => {
    let t = liveNoteRecordStart + p.t;
    if (scaleLength && t > scaleLength) t -= scaleLength; // wrapped around the loop while held
    const c = colorForSemitones(p.semitones);
    return { x: timeToX(t), y: semitonesToY(p.semitones), c: [c[0], c[1], c[2], pulse] };
  });

  strokeWeight(3);
  noFill();
  for (let i = 0; i < pts.length - 1; i++) {
    strokeGradientLine(pts[i].x, pts[i].y, pts[i].c, pts[i + 1].x, pts[i + 1].y, pts[i + 1].c);
  }
  noStroke();
}

// Vertical guide lines marking every beat of the tempo grid, with the start
// of each measure (every 4th beat, since we're 4/4-only for now) drawn a
// little darker/heavier so the bar lines stand out from the plain beats.
function drawTempoGrid() {
  if (!scaleLength) return;
  const beatMs = beatIntervalMs();
  if (!beatMs || beatMs <= 0) return;

  const totalBeats = ceil(scaleLength / beatMs);
  for (let b = 0; b <= totalBeats; b++) {
    const t = b * beatMs;
    if (t > scaleLength) break;

    const x = rollX + (t / scaleLength) * rollWidth;
    const isMeasureStart = b % BEATS_PER_MEASURE === 0;

    stroke(isMeasureStart ? color(120, 128, 148, 200) : color(210, 214, 224, 150));
    strokeWeight(isMeasureStart ? 1.5 : 1);
    line(x, rollY, x, rollY + rollHeight);
  }
  noStroke();
}

// The single vertical bar showing where you are in the loop. It's not just
// a playback indicator - it's also where paste (Ctrl/Cmd+V) inserts notes
// and, in Split mode, where a click cuts a note. Drag its little flag at
// the top to scrub, or just click anywhere in the empty part of the roll
// to jump it there.
function drawEditCursor() {
  const x = rollX + (editCursorTime / scaleLength) * rollWidth;

  stroke(isPlaying ? color(70, 83, 107) : color(120, 128, 148, 210));
  strokeWeight(2);
  line(x, rollY, x, rollY + rollHeight);
  noStroke();

  fill(mouseOverCursorHandle() || draggingCursor ? color(70, 83, 107) : color(120, 128, 148));
  triangle(x - 5, rollY - CURSOR_HANDLE_HEIGHT, x + 5, rollY - CURSOR_HANDLE_HEIGHT, x, rollY + 2);
}

function mouseOverCursorHandle() {
  if (!scaleLength) return false;
  const x = rollX + (editCursorTime / scaleLength) * rollWidth;
  return (
    mouseX >= x - 8 && mouseX <= x + 8 &&
    mouseY >= rollY - CURSOR_HANDLE_HEIGHT - 2 && mouseY <= rollY + 4
  );
}

// Moves the position bar, and - if a loop already exists - seeks playback
// to match. Used by both dragging the bar's handle and clicking empty
// background.
function seekTo(timeMs) {
  if (!scaleLength) return;
  editCursorTime = constrain(timeMs, 0, scaleLength);

  if (!loopLength) return; // still on the very first pass - nothing to sync up yet

  loopStartTime = millis() - editCursorTime;

  // Cut off anything currently sounding from the old position, and fix up
  // each note's hasStarted/hasEnded so playback picks back up correctly
  // from the new spot instead of re-triggering or skipping notes.
  playbackVoices.forEach((voice) => voice.osc.amp(0, 0.03));
  tracks.forEach((track) => {
    track.notes.forEach((note) => {
      const noteEnd = note.startTime + note.duration;
      if (noteEnd <= editCursorTime) {
        note.hasStarted = true;
        note.hasEnded = true;
      } else if (note.startTime >= editCursorTime) {
        note.hasStarted = false;
        note.hasEnded = false;
      } else {
        // The bar landed inside this note - treat it as already sounding
        // (no re-trigger click), but still due for a clean release later.
        note.hasStarted = true;
        note.hasEnded = false;
      }
    });
  });
}

// The rubber-band box while dragging a selection across multiple notes.
function drawMarquee() {
  if (!marqueeStart || !marqueeCurrent) return;

  const x1 = min(marqueeStart.x, marqueeCurrent.x);
  const x2 = max(marqueeStart.x, marqueeCurrent.x);
  const y1 = min(marqueeStart.y, marqueeCurrent.y);
  const y2 = max(marqueeStart.y, marqueeCurrent.y);

  noFill();
  stroke(108, 107, 245, 200); // the page's --accent indigo
  strokeWeight(1.5);
  rect(x1, y1, x2 - x1, y2 - y1);
  noStroke();
}

// Figures out which note (if any) the mouse is hovering over the LINE of,
// and which single point (if any) it's close enough to grab directly -
// used both for the little visual affordances and to decide what a click
// should do. Also updates the cursor icon to match whatever's being
// hovered, including the position bar's handle and Split mode.
function updateHoverState() {
  hoveredNote = null;
  hoveredPoint = null;

  if (mouseOverCursorHandle() && !draggedNote && !draggingCursor && !marqueeStart) {
    cursor("ew-resize");
    return;
  }

  if (splitMode) {
    const overRoll =
      mouseX >= rollX && mouseX <= rollX + rollWidth &&
      mouseY >= rollY && mouseY <= rollY + rollHeight;
    cursor(overRoll ? CROSS : ARROW);
    return;
  }

  if (draggedNote || draggingCursor || marqueeStart) return; // don't fight the cursor mid-action

  hoveredPoint = findPointUnderMouse();
  if (hoveredPoint) {
    cursor("grab");
    return;
  }

  const lineHit = findNoteLineUnderMouse();
  if (lineHit) {
    hoveredNote = lineHit.note;
    cursor("move");
    return;
  }

  cursor(ARROW);
}

function drawNote(note) {
  const pts = notePoints(note);
  if (pts.length === 0) return;

  // Each dot gets the color for its own pitch, and each connecting segment
  // fades between its two endpoints' colors - so the note's whole line reads
  // as a smooth red-to-blue gradient that tracks its pitch bend, rather than
  // one flat color for the whole instrument.
  const colors = note.curve.map((p) => colorForSemitones(p.semitones));
  const selected = isNoteSelected(note);

  strokeWeight(selected ? 3.5 : 2.5);
  noFill();
  for (let i = 0; i < pts.length - 1; i++) {
    strokeGradientLine(pts[i].x, pts[i].y, colors[i], pts[i + 1].x, pts[i + 1].y, colors[i + 1]);
  }
  noStroke();

  pts.forEach((p, i) => {
    const isEndpoint = i === 0 || i === pts.length - 1;
    const isHovered = hoveredPoint && hoveredPoint.note === note && hoveredPoint.index === i;
    const baseSize = isEndpoint ? 9 : 7;
    const size = isHovered ? baseSize + 3 : baseSize;
    const c = colors[i];

    fill(c[0], c[1], c[2]);
    circle(p.x, p.y, size);

    if (selected) {
      noFill();
      stroke(70, 83, 107);
      strokeWeight(1.5);
      circle(p.x, p.y, size + 4);
      noStroke();
    }
  });
}


// ============================================================
// Multi-select, clipboard, splitting, and undo/redo
// ============================================================

// selectedNotes holds { note, track } pairs - a note's track is stored
// alongside it because that's what deleting/cutting/dragging-as-a-group
// need, and a note object on its own doesn't know which track array it
// lives in.
let selectedNotes = [];

function isNoteSelected(note) {
  return selectedNotes.some((entry) => entry.note === note);
}

function selectOnly(note, track) {
  selectedNotes = [{ note, track }];
}

function addToSelection(note, track) {
  if (!isNoteSelected(note)) selectedNotes.push({ note, track });
}

function toggleNoteSelection(note, track) {
  const i = selectedNotes.findIndex((entry) => entry.note === note);
  if (i === -1) {
    selectedNotes.push({ note, track });
  } else {
    selectedNotes.splice(i, 1);
  }
}

function clearSelection() {
  selectedNotes = [];
}

// ---------- Clipboard ----------
let clipboard = []; // [{ startTime, duration, instrument, velocity, curve, trackIndex }, ...]

function copySelectedNotes() {
  if (selectedNotes.length === 0) return;
  clipboard = selectedNotes.map(({ note, track }) => ({
    startTime: note.startTime,
    duration: note.duration,
    instrument: note.instrument,
    velocity: note.velocity,
    curve: clonePitchCurve(note.curve),
    trackIndex: tracks.indexOf(track)
  }));
}

function cutSelectedNotes() {
  if (selectedNotes.length === 0) return;
  copySelectedNotes();
  deleteSelectedNotes(); // pushes its own undo snapshot
}

// Pastes the clipboard starting at the position bar, preserving both the
// relative spacing between the copied notes and which track each one came
// from. Whatever gets pasted becomes the new selection, ready to drag.
function pasteNotes() {
  if (clipboard.length === 0 || !loopLength) return;

  pushUndoSnapshot();

  const earliestStart = min(clipboard.map((n) => n.startTime));
  const shift = editCursorTime - earliestStart;
  const pasted = [];

  clipboard.forEach((copiedNote) => {
    const track = tracks[copiedNote.trackIndex] || tracks[tracks.length - 1];
    if (!track) return;

    let startTime = ((copiedNote.startTime + shift) % loopLength + loopLength) % loopLength;
    let duration = copiedNote.duration;
    let curve = clonePitchCurve(copiedNote.curve);
    if (startTime + duration > loopLength) {
      duration = loopLength - startTime;
      curve = clipPitchCurve(curve, duration);
    }

    const newNote = {
      startTime,
      duration,
      instrument: copiedNote.instrument,
      velocity: copiedNote.velocity,
      curve,
      hasStarted: false,
      hasEnded: false
    };
    track.notes.push(newNote);
    pasted.push({ note: newNote, track });
  });

  selectedNotes = pasted;
  refreshTrackListUI();
}

// ---------- Marquee (click-and-drag box select) ----------
let marqueeStart = null;     // {x, y} in canvas coords - set the moment the mouse goes down on empty background
let marqueeCurrent = null;   // {x, y} - updated while dragging
let marqueeAdditive = false; // shift was held when the drag started - add to the selection instead of replacing it
const CLICK_DRAG_THRESHOLD = 4; // px of movement below which a press+release counts as a click, not a drag

function applyMarqueeSelection() {
  const x1 = min(marqueeStart.x, marqueeCurrent.x);
  const x2 = max(marqueeStart.x, marqueeCurrent.x);
  const y1 = min(marqueeStart.y, marqueeCurrent.y);
  const y2 = max(marqueeStart.y, marqueeCurrent.y);

  if (!marqueeAdditive) clearSelection();

  tracks.forEach((track) => {
    track.notes.forEach((note) => {
      const intersects = notePoints(note).some(
        (p) => p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2
      );
      if (intersects) addToSelection(note, track);
    });
  });
}

// ---------- Split mode ----------
// Toggled by the Split button or the "S" key. While it's on, clicking
// ANYWHERE in the roll - not just precisely on a note - moves the position
// bar there and slices every note (in every track) that crosses that exact
// moment. Targeting by time rather than needing to hit a thin line is what
// makes this more precise than clicking the note itself.
let splitMode = false;

function toggleSplitMode() {
  splitMode = !splitMode;
  const btn = select("#splitBtn");
  if (splitMode) {
    btn.addClass("active");
  } else {
    btn.removeClass("active");
  }
}

function splitNotesAt(timeMs) {
  if (!loopLength) return;

  pushUndoSnapshot();

  tracks.forEach((track) => {
    const toAdd = [];
    track.notes = track.notes.filter((note) => {
      const noteEnd = note.startTime + note.duration;
      const canSplit =
        timeMs - note.startTime >= MIN_NOTE_DURATION &&
        noteEnd - timeMs >= MIN_NOTE_DURATION;

      if (!canSplit) return true; // leave this note alone

      // Split the pitch curve at the same instant as the note itself, with
      // an interpolated point injected right at the cut so neither half's
      // pitch jumps at the seam.
      const splitOffset = timeMs - note.startTime;
      const valueAtSplit = interpolatePitchCurve(note.curve, splitOffset);
      const firstCurve = clipPitchCurve(note.curve, splitOffset);
      const secondCurve = [{ t: 0, semitones: valueAtSplit }].concat(
        (note.curve || [])
          .filter((sample) => sample.t > splitOffset)
          .map((sample) => ({ t: sample.t - splitOffset, semitones: sample.semitones }))
      );

      toAdd.push(
        {
          startTime: note.startTime,
          duration: timeMs - note.startTime,
          instrument: note.instrument,
          velocity: note.velocity,
          curve: firstCurve,
          hasStarted: false,
          hasEnded: false
        },
        {
          startTime: timeMs,
          duration: noteEnd - timeMs,
          instrument: note.instrument,
          velocity: note.velocity,
          curve: secondCurve,
          hasStarted: false,
          hasEnded: false
        }
      );
      return false; // the original is replaced by the two halves above
    });
    track.notes.push(...toAdd);
  });

  clearSelection();
  refreshTrackListUI();
}

// ---------- Save / Open (as a downloadable .json file) ----------
// There's no server here, so "saving" means handing the browser a file to
// download, and "opening" means reading one back in through a file picker.
// The saved format is plain JSON: the tempo and every track's notes - not
// transport state, the selected instrument, or the latency offset, since
// those belong to a particular sit-down at the glove, not to the song.
let currentFileName = "my-loop.json";

function songToFileName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase().endsWith(".json") ? trimmed : trimmed + ".json";
}

function serializeSong() {
  return {
    type: "fsr-drum-glove-song",
    version: 2, // v2 = notes store an absolute pitch `curve` instead of pitchIndex+bendCurve
    bpm: bpm,
    loopLength: loopLength,
    tracks: tracks
  };
}

function downloadSong(filename) {
  const json = JSON.stringify(serializeSong(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  currentFileName = filename;
  updateCurrentFileLabel();
}

function saveSong() {
  if (!loopLength) {
    alert("Nothing recorded yet - record a first pass before saving.");
    return;
  }
  downloadSong(currentFileName);
}

function saveSongAs() {
  if (!loopLength) {
    alert("Nothing recorded yet - record a first pass before saving.");
    return;
  }
  const chosen = songToFileName(prompt("Save as filename:", currentFileName));
  if (!chosen) return; // cancelled, or typed nothing
  downloadSong(chosen);
}

function updateCurrentFileLabel() {
  const label = select("#currentFileLabel");
  if (label) label.html(currentFileName);
}

// Reads a File the person picked (via the hidden file input) and loads it
// as the current song, replacing whatever's here now - but that replace is
// itself undoable, in case Open was clicked by mistake.
function openSongFile(file) {
  const reader = new FileReader();
  reader.onload = (event) => {
    let data;
    try {
      data = JSON.parse(event.target.result);
    } catch (err) {
      alert("Couldn't read that file - it doesn't look like a saved loop (bad JSON).");
      return;
    }
    if (!data || !Array.isArray(data.tracks)) {
      alert("Couldn't read that file - it doesn't look like a saved loop.");
      return;
    }
    loadSongData(data);
    currentFileName = file.name;
    updateCurrentFileLabel();
  };
  reader.onerror = () => alert("Couldn't read that file.");
  reader.readAsText(file);
}

// Works out a note's pitch curve regardless of which generation of the save
// format it came from:
//  - current: an explicit `curve` (absolute semitones) - used as-is.
//  - previous: a fixed `pitchIndex` plus a relative `bendCurve` on top.
//  - original: just a fixed `pitchIndex`, from before bending existed at all.
function curveFromLoadedNote(note) {
  if (Array.isArray(note.curve) && note.curve.length > 0) {
    return clonePitchCurve(note.curve);
  }

  const baseSemitones = typeof note.pitchIndex === "number" ? (SCALE_SEMITONES[note.pitchIndex] || 0) : 0;
  if (Array.isArray(note.bendCurve) && note.bendCurve.length > 0) {
    return note.bendCurve.map((s) => ({ t: s.t, semitones: baseSemitones + (s.semitones || 0) }));
  }
  return [{ t: 0, semitones: baseSemitones }, { t: note.duration || 0, semitones: baseSemitones }];
}

function loadSongData(data) {
  pushUndoSnapshot();

  isRecording = false;
  isPlaying = false;
  currentTakeNotes = [];
  editCursorTime = 0;

  if (typeof data.bpm === "number" && data.bpm > 0) {
    bpm = data.bpm;
    const bpmInput = select("#bpmInput");
    if (bpmInput) bpmInput.value(bpm);
  }

  loopLength = data.loopLength || null;

  playbackVoices.forEach((voice) => voice.osc.amp(0, 0.03));
  tracks = data.tracks.map((track) => ({
    notes: (track.notes || []).map((note) => ({
      startTime: note.startTime,
      duration: note.duration,
      instrument: note.instrument,
      velocity: typeof note.velocity === "number" ? note.velocity : FIXED_VELOCITY,
      curve: curveFromLoadedNote(note),
      hasStarted: false,
      hasEnded: false
    }))
  }));
  playbackVoices = tracks.map(() => {
    const osc = new p5.Oscillator("sine");
    osc.amp(0);
    osc.start();
    return { osc: osc, lastFreqSet: 0 };
  });

  clearSelection();
  updateTransportButtonLabels();
  refreshTrackListUI();
}

// ---------- Undo / redo ----------
// Snapshots just the musical content (tracks + loop length) - not
// transport state like play/record, or which notes happen to be selected -
// since that's what "undo" means here: undo an edit, not un-press a button.
let undoStack = [];
let redoStack = [];
const UNDO_LIMIT = 50;

function cloneState() {
  return {
    loopLength: loopLength,
    tracks: JSON.parse(JSON.stringify(tracks))
  };
}

function pushUndoSnapshot() {
  undoStack.push(cloneState());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = []; // a fresh edit invalidates whatever redo history there was
  updateUndoRedoButtons();
}

function restoreState(state) {
  loopLength = state.loopLength;
  tracks = JSON.parse(JSON.stringify(state.tracks));

  // Match playbackVoices up to the restored track count.
  playbackVoices.forEach((voice) => voice.osc.amp(0, 0.03));
  while (playbackVoices.length < tracks.length) {
    const osc = new p5.Oscillator("sine");
    osc.amp(0);
    osc.start();
    playbackVoices.push({ osc: osc, lastFreqSet: 0 });
  }
  playbackVoices.length = tracks.length;

  clearSelection();
  refreshTrackListUI();
  updateUndoRedoButtons();
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(cloneState());
  restoreState(undoStack.pop());
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(cloneState());
  restoreState(redoStack.pop());
}

function updateUndoRedoButtons() {
  const undoBtn = select("#undoBtn");
  const redoBtn = select("#redoBtn");
  if (undoBtn) undoBtn.elt.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.elt.disabled = redoStack.length === 0;
}


// ============================================================
// Mouse interaction: the position bar, dragging points/notes,
// marquee (box) select, and Split mode
// ============================================================

// The closest breakpoint dot to the mouse, across every note in every
// track, within POINT_HIT_RADIUS - or null if nothing's close enough.
function findPointUnderMouse() {
  let best = null;
  let bestDist = POINT_HIT_RADIUS;

  tracks.forEach((track) => {
    track.notes.forEach((note) => {
      notePoints(note).forEach((p, i) => {
        const d = dist(mouseX, mouseY, p.x, p.y);
        if (d < bestDist) {
          bestDist = d;
          best = { note, track, index: i };
        }
      });
    });
  });

  return best;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = constrain(t, 0, 1);
  return dist(px, py, x1 + t * dx, y1 + t * dy);
}

// The closest note LINE (the segments between its dots, not the dots
// themselves) to the mouse, within LINE_HIT_RADIUS - used for whole-note
// selection/move, so grabbing between two dots still grabs the note.
function findNoteLineUnderMouse() {
  let best = null;
  let bestDist = LINE_HIT_RADIUS;

  tracks.forEach((track) => {
    track.notes.forEach((note) => {
      const pts = notePoints(note);
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distToSegment(mouseX, mouseY, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
        if (d < bestDist) {
          bestDist = d;
          best = { note, track };
        }
      }
    });
  });

  return best;
}

function mousePressed() {
  if (!scaleLength) return; // nothing drawn yet to click on

  // Grabbing the position bar's handle always wins, regardless of mode.
  if (mouseOverCursorHandle()) {
    draggingCursor = true;
    return;
  }

  const overRoll =
    mouseX >= rollX && mouseX <= rollX + rollWidth &&
    mouseY >= rollY && mouseY <= rollY + rollHeight;

  if (splitMode) {
    if (overRoll) {
      const t = ((mouseX - rollX) / rollWidth) * scaleLength;
      seekTo(t);
      splitNotesAt(t);
    }
    return;
  }

  // A single dot always wins over the line/whole-note hit test, so you can
  // always reshape a precise point even where notes are close together.
  const pointHit = findPointUnderMouse();
  if (pointHit) {
    pushUndoSnapshot();
    selectOnly(pointHit.note, pointHit.track);
    draggedNote = pointHit.note;
    dragMode = "point";
    dragPointIndex = pointHit.index;
    return;
  }

  const lineHit = findNoteLineUnderMouse();
  if (lineHit) {
    if (keyIsDown(SHIFT)) {
      toggleNoteSelection(lineHit.note, lineHit.track);
      return; // shift-click only changes the selection, no drag
    }

    if (!isNoteSelected(lineHit.note)) {
      selectOnly(lineHit.note, lineHit.track);
    }
    // else: already part of a multi-selection - keep the whole group
    // selected and drag it together.

    pushUndoSnapshot();
    draggedNote = lineHit.note;
    dragMode = "move";
    dragStartMouseX = mouseX;
    dragStartMouseY = mouseY;
    dragGroupStart = selectedNotes.map((entry) => ({
      note: entry.note,
      startTime: entry.note.startTime,
      curve: clonePitchCurve(entry.note.curve)
    }));
    return;
  }

  // Clicked empty background - could be the start of a marquee drag, or
  // (if it turns out to be just a click - see mouseReleased) a request to
  // move the position bar there and clear the selection. Only arm this for
  // clicks actually inside the roll - otherwise clicking a toolbar button
  // (which also reaches this global handler) would be misread as a click
  // on the timeline.
  if (overRoll) {
    marqueeStart = { x: mouseX, y: mouseY };
    marqueeCurrent = { x: mouseX, y: mouseY };
    marqueeAdditive = keyIsDown(SHIFT);
  }
}

// Reshapes a single breakpoint of draggedNote to follow the mouse, in both
// time and pitch. Neighboring points bound how far it can move in time (so
// dots can't cross past each other and scramble the curve's order) - except
// the very first/last point, whose only neighbor-side bound is the edge of
// the roll, so dragging them past the note's current edge naturally
// extends or shortens it. Whichever point ends up earliest/latest becomes
// the new startTime/duration, and every point's time is re-expressed
// relative to that.
function updateDraggedPoint() {
  const note = draggedNote;
  const idx = dragPointIndex;
  const absTimes = note.curve.map((p) => note.startTime + p.t);

  const lowerBound = idx > 0 ? absTimes[idx - 1] + MIN_POINT_GAP : 0;
  const upperBound = idx < absTimes.length - 1 ? absTimes[idx + 1] - MIN_POINT_GAP : scaleLength;
  const safeUpper = max(lowerBound, upperBound);

  const mouseTimeAbs = ((mouseX - rollX) / rollWidth) * scaleLength;
  const newTimeAbs = constrain(mouseTimeAbs, lowerBound, safeUpper);
  const newSemitones = constrain(yToSemitones(mouseY), GRAPH_SEMITONE_MIN, GRAPH_SEMITONE_MAX);

  const updatedAbs = note.curve.map((p, i) => ({
    tAbs: i === idx ? newTimeAbs : note.startTime + p.t,
    semitones: i === idx ? newSemitones : p.semitones
  }));

  const minT = updatedAbs[0].tAbs;
  const maxT = updatedAbs[updatedAbs.length - 1].tAbs;
  note.startTime = minT;
  note.duration = max(MIN_NOTE_DURATION, maxT - minT);
  note.curve = updatedAbs.map((p) => ({ t: p.tAbs - minT, semitones: p.semitones }));
}

function mouseDragged() {
  if (draggingCursor) {
    seekTo(((mouseX - rollX) / rollWidth) * scaleLength);
    return;
  }

  if (marqueeStart) {
    marqueeCurrent = { x: mouseX, y: mouseY };
    return;
  }

  if (!draggedNote) return;

  if (dragMode === "point") {
    updateDraggedPoint();

  } else if (dragMode === "move") {
    // Whole-note (or whole-selection) move: shift every selected note's
    // start time and add a uniform pitch offset to every one of its
    // points, keeping its shape - clamped as ONE shared delta across the
    // whole group so nothing near an edge clips out on its own and warps
    // the pattern out of shape.
    const rawTimeDelta = ((mouseX - dragStartMouseX) / rollWidth) * scaleLength;
    const rawSemitoneDelta = yDeltaToSemitoneDelta(mouseY - dragStartMouseY);

    let minTimeDelta = -Infinity, maxTimeDelta = Infinity;
    let minSemitoneDelta = -Infinity, maxSemitoneDelta = Infinity;

    dragGroupStart.forEach(({ startTime, curve }) => {
      const duration = curve[curve.length - 1].t;
      minTimeDelta = max(minTimeDelta, -startTime);
      maxTimeDelta = min(maxTimeDelta, scaleLength - duration - startTime);

      curve.forEach((p) => {
        minSemitoneDelta = max(minSemitoneDelta, GRAPH_SEMITONE_MIN - p.semitones);
        maxSemitoneDelta = min(maxSemitoneDelta, GRAPH_SEMITONE_MAX - p.semitones);
      });
    });

    const timeDelta = constrain(rawTimeDelta, minTimeDelta, maxTimeDelta);
    const semitoneDelta = constrain(rawSemitoneDelta, minSemitoneDelta, maxSemitoneDelta);

    dragGroupStart.forEach(({ note, startTime, curve }) => {
      note.startTime = startTime + timeDelta;
      note.curve = curve.map((p) => ({ t: p.t, semitones: p.semitones + semitoneDelta }));
    });
  }
}

function mouseReleased() {
  if (draggingCursor) {
    draggingCursor = false;
    return;
  }

  if (marqueeStart) {
    const dragDist = dist(marqueeStart.x, marqueeStart.y, mouseX, mouseY);

    if (dragDist < CLICK_DRAG_THRESHOLD) {
      // Just a click, not a drag (marqueeStart is only ever set for clicks
      // that landed inside the roll, so no bounds check needed here) -
      // move the position bar there and clear the selection.
      seekTo(((marqueeStart.x - rollX) / rollWidth) * scaleLength);
      clearSelection();
    } else {
      applyMarqueeSelection();
    }

    marqueeStart = null;
    marqueeCurrent = null;
    return;
  }

  draggedNote = null;
  dragMode = null;
  dragPointIndex = -1;
  dragGroupStart = [];
}


// ============================================================
// On-screen controls (buttons) + keyboard shortcuts
// ============================================================

function hookUpButtons() {
  select("#saveBtn").mousePressed(saveSong);
  select("#saveAsBtn").mousePressed(saveSongAs);
  select("#openBtn").mousePressed(() => select("#openFileInput").elt.click());
  select("#openFileInput").elt.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) openSongFile(file);
    event.target.value = ""; // so picking the same file again still fires "change"
  });

  select("#connectBtn").mousePressed(connectToArduino);
  select("#recordBtn").mousePressed(toggleRecord);
  select("#playBtn").mousePressed(togglePlay);
  select("#quantizeBtn").mousePressed(quantizeAllNotes);
  select("#splitBtn").mousePressed(toggleSplitMode);
  select("#undoBtn").mousePressed(undo);
  select("#redoBtn").mousePressed(redo);
  select("#clearAllBtn").mousePressed(clearAll);

  selectAll(".instBtn").forEach((btn) => {
    btn.mousePressed(() => setInstrument(btn.attribute("data-inst")));
  });

  const bpmInput = select("#bpmInput");
  bpmInput.input(() => {
    const v = parseFloat(bpmInput.value());
    if (!isNaN(v) && v > 0) bpm = v;
  });

  const latencyInput = select("#latencyInput");
  latencyInput.input(() => {
    const v = parseFloat(latencyInput.value());
    if (!isNaN(v)) inputLatencyMs = v;
  });

  setInstrument(currentInstrument); // highlight the starting instrument
  updateUndoRedoButtons();
}

function setInstrument(name) {
  currentInstrument = name;
  selectAll(".instBtn").forEach((btn) => {
    if (btn.attribute("data-inst") === name) {
      btn.addClass("active");
    } else {
      btn.removeClass("active");
    }
  });
}

function buildPitchButtons() {
  const holder = select("#pitchButtons");
  for (let i = 0; i < PITCH_FREQUENCIES.length; i++) {
    // Two-line label: the key you press on top, the note name underneath -
    // e.g. "1" over "C" - so it's obvious which number plays which note.
    const btn = createButton(`${i + 1}<br>${PITCH_NAMES[i]}`);
    btn.parent(holder);
    btn.class("pitchBtn");
    btn.mousePressed(() => setPitch(i));
  }
  highlightPitchButton(0);
}

function setPitch(index) {
  currentPitchIndex = index;
  highlightPitchButton(index);
}

function highlightPitchButton(index) {
  const buttons = selectAll(".pitchBtn");
  buttons.forEach((btn, i) => {
    if (i === index) {
      btn.addClass("active");
    } else {
      btn.removeClass("active");
    }
  });
}

function keyPressed(event) {
  // Let the browser handle typing (including its own copy/paste) normally
  // when focus is in one of the toolbar's number fields.
  const activeTag = document.activeElement && document.activeElement.tagName;
  if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

  const cmdOrCtrl = event && (event.ctrlKey || event.metaKey);
  const isZ = key === "z" || key === "Z";
  const isY = key === "y" || key === "Y";
  const isC = key === "c" || key === "C";
  const isX = key === "x" || key === "X";
  const isV = key === "v" || key === "V";

  if (cmdOrCtrl && isZ && event.shiftKey) {
    redo();
    event.preventDefault();
    return;
  }
  if (cmdOrCtrl && isZ) {
    undo();
    event.preventDefault();
    return;
  }
  if (cmdOrCtrl && isY) {
    redo();
    event.preventDefault();
    return;
  }
  if (cmdOrCtrl && isC) {
    copySelectedNotes();
    event.preventDefault();
    return;
  }
  if (cmdOrCtrl && isX) {
    cutSelectedNotes();
    event.preventDefault();
    return;
  }
  if (cmdOrCtrl && isV) {
    pasteNotes();
    event.preventDefault();
    return;
  }

  if (key >= "1" && key <= "8") {
    setPitch(key.charCodeAt(0) - "1".charCodeAt(0));
  } else if (isZ) {
    setInstrument("pluck");
  } else if (isX) {
    setInstrument("pad");
  } else if (isC) {
    setInstrument("bass");
  } else if (key === "s" || key === "S") {
    toggleSplitMode();
  } else if (keyCode === BACKSPACE || keyCode === DELETE) {
    deleteSelectedNotes();
    if (event) event.preventDefault(); // don't let Backspace navigate the page back
  }
}

function updateTransportButtonLabels() {
  const recordBtn = select("#recordBtn");
  if (isRecording) {
    recordBtn.html("■ Stop Recording");
    recordBtn.addClass("recording");
  } else {
    recordBtn.html(loopLength ? "● Overdub" : "● Record");
    recordBtn.removeClass("recording");
  }

  const playBtn = select("#playBtn");
  playBtn.html(isPlaying ? "■ Stop" : "▶ Play");
  if (isPlaying) {
    playBtn.addClass("playing");
  } else {
    playBtn.removeClass("playing");
  }
}

function refreshTrackListUI() {
  const holder = select("#trackList");
  holder.html(""); // wipe and rebuild

  tracks.forEach((track, index) => {
    const row = createDiv("");
    row.class("trackRow");
    row.parent(holder);

    createSpan(`Track ${index + 1} (${track.notes.length} notes)`).parent(row);

    const clearBtn = createButton("Clear");
    clearBtn.parent(row);
    clearBtn.mousePressed(() => clearTrack(index));
  });
}

function updateForceMeterDisplay() {
  // Mapped against FORCE_MAX (not the ADC's theoretical 1023 ceiling) so the
  // on-screen meter actually reaches full width on your hardest real press.
  const percent = constrain(map(forceValue, 0, FORCE_MAX, 0, 100), 0, 100);
  select("#forceMeterInner").style("width", percent + "%");
  select("#forceReading").html("force: " + forceValue);
}


// ============================================================
// Talking to the Arduino over Web Serial
// ============================================================

async function connectToArduino() {
  if (!("serial" in navigator)) {
    const msg = window.isSecureContext
      ? "This browser doesn't support Web Serial. Please use Chrome or Edge."
      : "Web Serial needs a secure context (http://localhost or https://). " +
        "This page looks like it was opened directly from a file - serve it " +
        "with a local server instead (see README).";
    select("#connectionStatus").html("Not connected");
    alert(msg);
    return;
  }

  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 9600 });
    select("#connectionStatus").html("Connected");
    readSerialLoop(); // runs in the background - we don't await it here
  } catch (err) {
    console.log("Could not connect:", err);
    select("#connectionStatus").html("Not connected");
    if (err && err.name === "NotFoundError") {
      // User closed the port-picker dialog without choosing anything -
      // not a real error, so don't alarm them with a popup for it.
    } else if (err && err.name === "NetworkError") {
      alert(
        "Could not open the port - it's probably already in use by another " +
        "program (often the Arduino IDE's Serial Monitor/Plotter, or another " +
        "browser tab). Close that program/tab and click Connect again."
      );
    } else {
      alert("Could not connect: " + (err && err.message ? err.message : err));
    }
  }
}

async function readSerialLoop() {
  const textStream = serialPort.readable.pipeThrough(new TextDecoderStream());
  const reader = textStream.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    handleIncomingText(value);
  }
}

// The Arduino sends one reading per line, like "force:123\n". Serial data
// can arrive in odd-sized chunks, so we buffer it and only process whole
// lines once we see a newline.
function handleIncomingText(chunk) {
  incomingText += chunk;

  let newlineIndex;
  while ((newlineIndex = incomingText.indexOf("\n")) >= 0) {
    const line = incomingText.slice(0, newlineIndex).trim();
    incomingText = incomingText.slice(newlineIndex + 1);
    handleOneLine(line);
  }
}

function handleOneLine(line) {
  const parts = line.split(":"); // "force:123" -> ["force", "123"]
  if (parts.length === 2 && parts[0] === "force") {
    const num = parseInt(parts[1], 10);
    if (!isNaN(num)) {
      forceValue = num;
    }
  }
}
