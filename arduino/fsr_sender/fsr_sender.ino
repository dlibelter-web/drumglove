/*
  fsr_sender.ino
  Reads the FSR on A0 and streams labeled readings over Serial
  so the p5.js web interface can parse them.

  Format sent, once per loop: "force:NNN\n"  (NNN = 0-1023, the ADC's
  theoretical range - in practice this glove's FSR + resistor combo tops
  out around 400 under a real hard press. The web interface's own
  PRESS_THRESHOLD (10) already treats anything below that as "not
  pressed," so there's no separate deadzone here - one place to tune
  instead of two.)

  IMPORTANT: Close the Arduino IDE's Serial Monitor before opening
  the web interface — only one program can hold the serial port
  at a time, and the browser needs it.
*/

const int fsrPin = A0;

void setup() {
  Serial.begin(9600);
}

void loop() {
  int val = analogRead(fsrPin);
  Serial.print("force:");
  Serial.println(val);
  delay(10); // ~100 readings/sec - fast enough to catch a quick hit
}
