// Writes the soundtrack for a composition: a soft chord-pluck bed plus sound
// effects pitched to the same chords, all through one shared reverb so the
// effects sit inside the music instead of on top of it.
//
//   node video/synth.js <score.json> <out.wav>
//
// score.json: { duration, bpm, chords: [[midi...], ...] (one per bar),
//               sfx: [{ t, type: "type"|"pop"|"tap"|"chime"|"whoosh", note? }] }
const fs = require('fs');
const [scoreFile, out] = process.argv.slice(2);
const score = JSON.parse(fs.readFileSync(scoreFile, 'utf8'));
const SR = 44100;
const N = Math.round(score.duration * SR);
const L = new Float32Array(N), R = new Float32Array(N);
const send = new Float32Array(N); // reverb send (mono)

const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

function add(t0, len, fn, gain, pan = 0, rev = 0.25) {
  const s0 = Math.round(t0 * SR), n = Math.round(len * SR);
  const gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < n && s0 + i < N; i++) {
    if (s0 + i < 0) continue;
    const v = fn(i / SR);
    L[s0 + i] += v * gl; R[s0 + i] += v * gr; send[s0 + i] += v * gain * rev;
  }
}
// Plucked tone: sine + soft second harmonic, quick attack, exponential decay.
const pluck = (f, decay) => (t) =>
  (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t)) *
  Math.min(1, t / 0.006) * Math.exp(-t / decay);

const beat = 60 / score.bpm, bar = beat * 4;
// Music bed
score.chords.forEach((ch, b) => {
  const t0 = b * bar;
  // pad: chord tones, slow swell
  ch.forEach((m, k) => add(t0, bar + 0.4, (t) =>
    Math.sin(2 * Math.PI * hz(m) * t) * Math.min(1, t / 0.8) * Math.min(1, (bar + 0.4 - t) / 0.6),
    0.035, k % 2 ? 0.4 : -0.4, 0.5));
  // bass on 1 and 3
  [0, 2].forEach((q) => add(t0 + q * beat, beat * 1.8, pluck(hz(ch[0] - 12), 0.45), 0.16, 0, 0.05));
  // arpeggio on eighths
  for (let e = 0; e < 8; e++) {
    const m = ch[[0, 2, 1, 3, 2, 1, 3, 2][e] % ch.length] + 12;
    add(t0 + e * beat / 2, 0.6, pluck(hz(m), 0.22), 0.05, e % 2 ? 0.5 : -0.5, 0.35);
  }
  // soft kick on every beat, airy hat on offbeats
  for (let q = 0; q < 4; q++) {
    add(t0 + q * beat, 0.3, (t) => Math.sin(2 * Math.PI * (48 + 70 * Math.exp(-t * 30)) * t) * Math.exp(-t / 0.11), 0.22, 0, 0);
    add(t0 + q * beat + beat / 2, 0.06, (t) => rnd() * Math.exp(-t / 0.012), 0.025, 0.3, 0.1);
  }
});

const chordAt = (t) => score.chords[Math.min(score.chords.length - 1, Math.floor(t / bar))];
// Sound effects, pitched from the chord playing at that moment
for (const s of score.sfx) {
  const ch = chordAt(s.t);
  if (s.type === 'type') add(s.t, 0.03, (t) => rnd() * Math.exp(-t / 0.005), 0.05, 0.2, 0.1);
  if (s.type === 'pop') add(s.t, 0.5, pluck(hz(s.note || ch[1] + 24), 0.12), 0.09, 0.2, 0.4);
  if (s.type === 'tap') {
    add(s.t, 0.05, (t) => rnd() * Math.exp(-t / 0.008), 0.08, 0, 0.1);
    add(s.t, 0.8, pluck(hz(ch[0] + 24), 0.3), 0.1, 0, 0.5);
  }
  if (s.type === 'chime') ch.forEach((m, k) => add(s.t + k * 0.05, 1.8, pluck(hz(m + 24), 0.7), 0.05, k % 2 ? 0.5 : -0.5, 0.7));
  if (s.type === 'whoosh') {
    let lp = 0;
    add(s.t, 0.5, (t) => { lp += 0.08 * (rnd() - lp); return lp * Math.sin(Math.PI * t / 0.5); }, 0.5, 0, 0.3);
  }
}

// Shared reverb: a few feedback combs into the stereo bus
const combs = [[1557, 0.8], [1617, 0.79], [1491, 0.81], [1422, 0.8]];
for (const [d, fb] of combs) {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    buf[i] = send[i] + (i >= d ? buf[i - d] * fb * 0.85 : 0);
    const w = buf[i] * 0.12;
    if (d % 2) L[i] += w; else R[i] += w;
  }
}

// Fades and normalize
const fadeIn = 0.05 * SR, fadeOut = 1.6 * SR;
let peak = 0;
for (let i = 0; i < N; i++) {
  const g = Math.min(1, i / fadeIn, (N - i) / fadeOut);
  L[i] *= g; R[i] *= g; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.89 / peak;
const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(Math.tanh(L[i] * norm) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.tanh(R[i] * norm) * 32767), i * 4 + 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
fs.writeFileSync(out, Buffer.concat([h, data]));
