# FSR Drum Glove Looper

## Folder contents
```
drum_glove/
  arduino/fsr_sender/fsr_sender.ino   <- upload this to the Arduino
  web/index.html            <- open this in Chrome to run the interface
  web/style.css
  web/sketch.js             <- all the p5.js logic, heavily commented
```

## 1. Upload the Arduino sketch
1. Open `arduino/fsr_sender/fsr_sender.ino` in the Arduino IDE (the file has
   to sit in a folder with the same name for the IDE to open it).
2. Select your board (Arduino Uno R4 Minima) and port.
3. Upload it.
4. **Close the Serial Monitor** afterwards - only one program can hold the
   serial port at a time, and the web page needs it next.

## 2. Run the web interface
The FSR interface uses a browser feature called **Web Serial**, which only
works in Chrome or Edge, and only when the page is loaded from `http://`
(not by double-clicking the file). The easiest way to do that from VS Code:

- Install the **"Live Server"** extension (Extensions panel -> search "Live
  Server" by Ritwick Dey -> Install).
- Right-click `web/index.html` in the VS Code file explorer -> **"Open with
  Live Server"**.
- It opens automatically in your default browser. If that's not Chrome,
  copy the URL (looks like `http://127.0.0.1:5500/...`) into Chrome.

(No Live Server extension? Any local server works - e.g. running
`python3 -m http.server` from inside the `web` folder and visiting
`http://localhost:8000`.)

## 3. Connect and play
1. Click **Connect Arduino**, and pick your board from the browser's port
   list (this is the same picker Chrome always uses for Web Serial/USB).
2. Press the FSR - you should see the force meter move and hear a note.
3. Pick a pitch with keys **1-8** (or the on-screen buttons) and an
   instrument with **Z / X / C** (Pluck / Pad / Bass).
4. Press harder to bend that note's pitch **up** - it's a smooth glide, not
   steps, and it never bends down. Volume is fixed (force no longer changes
   it - see "Pitch bend" below).

## Pitch bend
Force does one job now: bending the currently-held note's pitch upward.
- Below a reading of **100**, the note plays at its plain pitch - no bend.
- From **100 up to 400** (this glove's calibrated max - see "If the FSR
  readings feel off" below), the bend rises smoothly the whole way, reaching
  +2 semitones (a whole tone) at 200, +4 at 300, and +6 (three whole tones)
  at 400.
- It only ever bends **up**, and it's a continuous glide - there's no
  stepping or snapping to notes in between.
- The bend is recorded and plays back exactly as performed: however the
  pitch moved while you held the sensor gets captured and replayed, not
  just a flat note.

## 4. Record a song
1. Click **Record**. Play a short pattern, then click the button again
   (now labeled "Stop Recording"). However long that took becomes your
   loop length, and it starts looping automatically.
2. Click **● Overdub** any time to add another layer in sync with the loop
   - e.g. record a bass line first, then overdub a pluck melody on top.
3. Editing notes in the box on screen:
   - **Select**: click a note, shift-click to add/remove more, or
     click-drag an empty patch of background to rubber-band a whole box of
     them at once.
   - **Move**: drag any selected note and the *whole* selection moves
     together (up/down = pitch, left/right = time).
   - **Stretch**: hover a note to see small arrows at its left/right edge -
     drag one to lengthen or shorten the note from that side.
   - **Delete**: Backspace or Delete removes every selected note.
   - **Copy / Cut / Paste**: Ctrl+C / Ctrl+X / Ctrl+V (Cmd on Mac). Paste
     inserts starting at the position bar (see below), keeping the copied
     notes' spacing and original tracks.
   - **Split**: click **✂ Split** or press **S** to toggle Split mode -
     while it's on, clicking anywhere in the roll slices every note at that
     exact moment (across every track), rather than needing to click
     precisely on a thin note. Click the button or press S again to go
     back to normal selecting/dragging.
   - **⌗ Quantize** snaps every note in every track to the nearest line of
     the tempo grid.
   - **↶ Undo / ↷ Redo** cover recording a take, deleting, moving,
     stretching, cutting, pasting, splitting, quantizing, and clearing a
     track or everything.
4. **Play / Stop** toggles whether the loop is audible. **Clear** next to
   a track removes just that layer; **Clear All** resets everything.

## Saving and loading a song
There's no server behind this page, so "saving" downloads your loop as a
`.json` file, and "opening" reads one back in:
- **💾 Save** downloads using the current filename (shown next to the File
  buttons, starting as `my-loop.json`).
- **Save As** asks for a filename first, then downloads and makes that the
  current filename for future Saves.
- **📂 Open** picks a `.json` file from your computer and loads it, replacing
  the current loop (that replacement is itself undoable with **Undo**, in
  case Open gets clicked by mistake).

A saved file holds the tempo and every track's notes - not things tied to a
particular sit-down at the glove, like which instrument is selected or the
latency offset. Because it's plain JSON, you can also open it in a text
editor to look at or hand-edit the raw note data if you're curious.

## The position bar
The vertical line in the roll is more than a playback indicator - it's the
"you are here" marker for editing too:
- While playing, it tracks along automatically.
- Drag its little flag at the top to scrub, or just click any empty spot in
  the roll to jump it there (this also stops whatever was mid-note at the
  old position, cleanly).
- **Paste** always inserts starting at wherever this bar is.
- In **Split mode**, it's what actually gets cut against - the bar jumps to
  your click, then that exact moment is where every crossing note gets sliced.
- Pressing **Play** afterward resumes from wherever the bar was left.

## Tempo grid and timing
The **Tempo** field sets the BPM used to draw the vertical beat lines (every
4th one, drawn darker, marks a measure) and used by **Quantize**. Only 4/4
is supported for now; more time signatures are a planned addition.

If notes still land slightly behind where you actually pressed the sensor,
nudge the **Latency comp** field (milliseconds) - raise it to shift newly
recorded notes earlier.

## If the FSR readings feel off
Two constants near the top of `sketch.js` calibrate the sensor to this
specific glove's FSR + resistor combo, which physically tops out well
short of the Arduino's theoretical 0-1023 ADC range:
- `PRESS_THRESHOLD` (currently `10`) is the raw value that counts as
  "pressed." If your resting value sits higher than that, raise this number
  until resting stays silent and a real press still triggers reliably.
- `FORCE_MAX` (currently `400`) is the raw value treated as "as hard as
  this glove can register" - it's the top end of every force-based mapping
  (the on-screen meter and the pitch bend). Watch the `force: NNN` readout
  while pressing as hard as you'd actually want to play, and set this to
  roughly that value.
- `FORCE_BEND_START` (currently `100`) and `BEND_MAX_SEMITONES` (currently
  `6`) shape the bend curve itself - see "Pitch bend" above.

## Known simplifications (fine for a class demo, worth knowing about)
- Each track can only play one note at a time (matches physically hitting
  the sensor with one hand) - no chords within a single track.
- Volume is fixed per note - force controls pitch bend only, not loudness.
- **Quantize** snaps every note across every track at once - there's no
  per-note quantize yet.
- **Undo/Redo** only cover note/track content (recording, editing,
  clearing) - not transport state (play/record), the selected instrument,
  or the tempo/latency fields. History is capped at the last 50 actions.
- Stopping playback mid-loop and resuming is approximate, not
  frame-perfect - for a live demo, it's easiest to just let it loop
  continuously once you start recording.
- A note's bend curve is captured as a series of samples while you hold the
  sensor - stretching a note's edge afterward time-warps that curve to fit,
  which keeps its shape but isn't a perfect re-performance at the new length.
