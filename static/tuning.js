// morlam tuning — lai (pentatonic modes of mor lam / khaen music) laid over a
// 12-note well temperament.
//
// Pitch = A4 reference × well-tempered ratio. A temperament is given as each
// pitch class's deviation from 12-TET in cents (C-based). Unlike equal
// temperament, every key has its own colour: lai on "near" keys (C, G, D, F)
// get purer thirds and fifths, remote keys sound tenser.

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

// Cents deviation from 12-TET for C, C♯, D, E♭, E, F, F♯, G, G♯, A, B♭, B.
const TEMPERAMENTS = {
  werckmeister3: { name: 'WERCKMEISTER III', cents: [0, -9.8, -7.8, -5.9, -9.8, -2.0, -11.7, -3.9, -7.8, -11.7, -3.9, -7.8] },
  kirnberger3:   { name: 'KIRNBERGER III',   cents: [0, -9.8, -6.8, -3.9, -13.7, -2.0, -9.8, -3.4, -7.8, -10.3, -2.0, -11.7] },
  vallotti:      { name: 'VALLOTTI',         cents: [0, -5.9, -3.9, -2.0, -7.8, 2.0, -7.8, -2.0, -3.9, -5.9, 0, -9.8] },
  young2:        { name: 'YOUNG II',         cents: [0, -9.8, -3.9, -5.9, -7.8, -2.0, -11.7, -2.0, -7.8, -5.9, -3.9, -9.8] },
  equal:         { name: '12-TET (EQUAL)',   cents: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
};

// The five lai of the khaen. Two "thang" (scale families):
//   thang yao (minor pentatonic)  — lai yai, lai noi
//   thang san (major pentatonic)  — lai sutsanaen, lai po sai, lai soi
// `tonic` is the pitch class the lai sits on for a standard khaen in A;
// `steps` are semitones above that tonic.
const LAI = {
  1: { name: 'LAI YAI',       sub: 'deep · lament',     tonic: 9, steps: [0, 3, 5, 7, 10] }, // A C D E G
  2: { name: 'LAI NOI',       sub: 'bright · tender',   tonic: 2, steps: [0, 3, 5, 7, 10] }, // D F G A C
  3: { name: 'LAI SUTSANAEN', sub: 'stately · old',     tonic: 7, steps: [0, 2, 5, 7, 9] },  // G A C D E
  4: { name: 'LAI PO SAI',    sub: 'lively · dance',    tonic: 0, steps: [0, 2, 5, 7, 9] },  // C D F G A
  5: { name: 'LAI SOI',       sub: 'flowing · teasing', tonic: 2, steps: [0, 2, 5, 7, 9] },  // D E G A B
};
const LAI_COUNT = 5;

const Tuning = {
  ref: 440,                    // A4
  temperament: 'werckmeister3',
  transpose: 0,                // semitones, shifts every lai's tonic

  // Frequency of a MIDI note under the current temperament, with A4 = ref.
  hz(midi) {
    const cents = (TEMPERAMENTS[this.temperament] || TEMPERAMENTS.equal).cents;
    const pc = ((midi % 12) + 12) % 12;
    // Keep A pinned to the reference: shift everything by A's own deviation.
    const dev = cents[pc] - cents[9];
    return this.ref * Math.pow(2, (midi - 69 + dev / 100) / 12);
  },

  centsOf(midi) {
    const cents = (TEMPERAMENTS[this.temperament] || TEMPERAMENTS.equal).cents;
    const pc = ((midi % 12) + 12) % 12;
    return cents[pc] - cents[9];
  },

  name(midi) { return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1); },

  lai(mode) { return LAI[mode] || LAI[1]; },

  // MIDI of the lai's tonic in octave 3 (the khaen's low drone register).
  tonicMidi(mode) {
    const pc = (this.lai(mode).tonic + this.transpose + 120) % 12;
    return 48 + pc; // C3..B3
  },

  // MIDI of scale degree `deg` (0-based, may exceed 5 to climb octaves).
  degreeMidi(mode, deg) {
    const steps = this.lai(mode).steps, n = steps.length;
    const oct = Math.floor(deg / n), i = ((deg % n) + n) % n;
    return this.tonicMidi(mode) + steps[i] + 12 * oct;
  },
};

window.Tuning = Tuning;
window.TEMPERAMENTS = TEMPERAMENTS;
window.LAI = LAI;
window.LAI_COUNT = LAI_COUNT;
