//! Synthesised drum + bass machine — 5 voices (kick, snare, hat, clap, bass)
//! on a 16-step grid. Includes preset patterns inspired by African folk music
//! (Afrobeat, Highlife, Bembe 6/8) and blues shuffle, plus a quantum-driven
//! swing/microtiming offset for organic feel.

use std::f32::consts::TAU;

#[derive(Default)]
struct Voice {
    phase: f32,
    env: f32,
    env_decay: f32,
    pitch: f32,
    pitch_drop: f32,
    pitch_drop_amt: f32,
    noise_amt: f32,
    body_amt: f32,
    // bass extras
    detune_phase: f32,
    is_bass: bool,
}

impl Voice {
    fn trigger(&mut self, pitch: f32, decay: f32, drop: f32, noise: f32, body: f32) {
        self.phase = 0.0;
        self.env = 1.0;
        self.env_decay = decay;
        self.pitch = pitch;
        self.pitch_drop = pitch * 4.0;
        self.pitch_drop_amt = drop;
        self.noise_amt = noise;
        self.body_amt = body;
        self.detune_phase = 0.0;
        self.is_bass = false;
    }

    fn trigger_bass(&mut self, freq: f32, decay: f32) {
        self.phase = 0.0;
        self.detune_phase = 0.0;
        self.env = 1.0;
        self.env_decay = decay;
        self.pitch = freq;
        self.pitch_drop = freq * 0.6;
        self.pitch_drop_amt = 0.5;
        self.noise_amt = 0.0;
        self.body_amt = 1.0;
        self.is_bass = true;
    }

    #[inline]
    fn process(&mut self, sr: f32, rng: &mut u32, detune_hz: f32) -> f32 {
        if self.env < 1e-6 { return 0.0; }
        *rng ^= *rng << 13;
        *rng ^= *rng >> 17;
        *rng ^= *rng << 5;
        let noise = (*rng as f32 / u32::MAX as f32) * 2.0 - 1.0;

        self.pitch_drop *= 0.9985;
        let f = self.pitch + self.pitch_drop * self.pitch_drop_amt;
        self.phase += TAU * f / sr;
        if self.phase > TAU { self.phase -= TAU; }

        let body = if self.is_bass {
            // detuned saw + sub-sine for fat bass
            self.detune_phase += TAU * (f + detune_hz) / sr;
            if self.detune_phase > TAU { self.detune_phase -= TAU; }
            let p1 = self.phase / TAU;
            let p2 = self.detune_phase / TAU;
            let saw1 = p1 * 2.0 - 1.0;
            let saw2 = p2 * 2.0 - 1.0;
            let sub = (self.phase * 0.5).sin();
            (saw1 + saw2) * 0.4 + sub * 0.6
        } else {
            self.phase.sin()
        };

        let out = body * self.body_amt + noise * self.noise_amt;
        let amp = self.env;
        self.env *= self.env_decay;
        out * amp
    }
}

pub struct DrumMachine {
    sample_rate: f32,
    samples_per_step: f32,
    step_counter: f32,
    current_step: u8,
    voices: [Voice; 5], // kick, snare, hat, clap, bass
    rng: u32,
    bass_notes: [f32; 16], // per-step pitch in Hz
}

impl DrumMachine {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate: sample_rate as f32,
            samples_per_step: sample_rate as f32 * 60.0 / (96.0 * 4.0),
            step_counter: 0.0,
            current_step: 15,
            voices: Default::default(),
            rng: 0xC0FFEE_u32,
            bass_notes: [55.0; 16],
        }
    }

    pub fn set_bpm(&mut self, bpm: f32) {
        let bpm = bpm.clamp(40.0, 240.0);
        self.samples_per_step = self.sample_rate * 60.0 / (bpm * 4.0);
    }

    pub fn set_bass_notes(&mut self, notes: &[f32; 16]) {
        self.bass_notes = *notes;
    }

    #[allow(dead_code)]
    pub fn current_step(&self) -> u8 { self.current_step }

    /// Advance one sample. `pattern[v]` is a 16-bit mask, bit 15 = step 0.
    /// `swing` in 0..0.5 shifts every odd 16th later — quantum-driven for organic groove.
    /// `bass_detune` Hz adds chorus/wobble to the bass.
    /// Returns (drum_voices_sum, bass_only).
    #[inline]
    pub fn process(&mut self, pattern: &[u16; 5], swing: f32, bass_detune: f32) -> (f32, f32) {
        self.step_counter += 1.0;

        // swing: delay odd 16ths by up to ~50% of a step
        let next_step = (self.current_step.wrapping_add(1)) & 15;
        let is_odd = next_step & 1 == 1;
        let step_thresh = if is_odd {
            self.samples_per_step * (1.0 + swing.clamp(0.0, 0.5))
        } else {
            self.samples_per_step
        };

        if self.step_counter >= step_thresh {
            self.step_counter -= step_thresh;
            self.current_step = next_step;
            let step = self.current_step as usize;
            if (pattern[0] >> (15 - step)) & 1 == 1 {
                self.voices[0].trigger(55.0, 0.99975, 1.0, 0.04, 1.0);
            }
            if (pattern[1] >> (15 - step)) & 1 == 1 {
                self.voices[1].trigger(200.0, 0.9994, 0.3, 0.7, 0.4);
            }
            if (pattern[2] >> (15 - step)) & 1 == 1 {
                self.voices[2].trigger(8000.0, 0.998, 0.0, 1.0, 0.0);
            }
            if (pattern[3] >> (15 - step)) & 1 == 1 {
                self.voices[3].trigger(1500.0, 0.9985, 0.0, 0.9, 0.1);
            }
            if (pattern[4] >> (15 - step)) & 1 == 1 {
                let n = self.bass_notes[step].max(20.0);
                self.voices[4].trigger_bass(n, 0.99985);
            }
        }
        let mut drum_sum = 0.0;
        for v in &mut self.voices[..4] {
            drum_sum += v.process(self.sample_rate, &mut self.rng, 0.0);
        }
        let bass_out = self.voices[4].process(self.sample_rate, &mut self.rng, bass_detune);
        (drum_sum * 0.45, bass_out * 0.6)
    }
}

/// Preset patterns. Returns (kick, snare, hat, clap, bass) bitmasks +
/// a 16-step bass-note schedule in Hz.
///
/// Step bit layout: bit 15 = step 0, bit 0 = step 15.
pub struct Preset {
    pub kick: u16,
    pub snare: u16,
    pub hat: u16,
    pub clap: u16,
    pub bass: u16,
    pub notes: [f32; 16],
    pub bpm: f32,
    pub swing: f32,
}

const fn pat(steps: &[usize]) -> u16 {
    let mut m: u16 = 0;
    let mut i = 0;
    while i < steps.len() {
        m |= 1u16 << (15 - steps[i]);
        i += 1;
    }
    m
}

/// Frequencies (Hz) for low bass notes — A1=55, low E1=41.2, etc.
const A1: f32 = 55.00;
const C2: f32 = 65.41;
const D2: f32 = 73.42;
const E2: f32 = 82.41;
const G2: f32 = 98.00;
const E1: f32 = 41.20;
const A0: f32 = 27.50;

pub fn preset(idx: u8) -> Preset {
    match idx {
        // 1 — Afrobeat (Fela-ish): kick on 1 & 11, syncopated snare/clap,
        //     16th hat, walking bass on Am
        1 => Preset {
            kick:  pat(&[0, 10]),
            snare: pat(&[4, 12]),
            hat:   pat(&[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]),
            clap:  pat(&[6, 14]),
            bass:  pat(&[0, 3, 6, 8, 10, 13]),
            notes: [A1,A1,A1,C2,C2,C2,E2,E2,E2,E2,D2,D2,D2,C2,C2,A1],
            bpm: 108.0,
            swing: 0.0,
        },
        // 2 — Highlife (Ghana 12/8 felt over 16): kick on 1,5,9,13; bell on 1,4,7,10,13
        2 => Preset {
            kick:  pat(&[0, 4, 8, 12]),
            snare: pat(&[6, 14]),
            hat:   pat(&[0, 3, 6, 9, 12, 15]),
            clap:  pat(&[3, 11]),
            bass:  pat(&[0, 4, 6, 8, 12]),
            notes: [E2,E2,E2,E2,G2,G2,G2,G2,A1,A1,A1,A1,D2,D2,D2,D2],
            bpm: 112.0,
            swing: 0.12,
        },
        // 3 — Blues shuffle: kick 1/3, snare 2/4, swung hats, walking bass
        3 => Preset {
            kick:  pat(&[0, 8]),
            snare: pat(&[4, 12]),
            hat:   pat(&[0,2,4,6,8,10,12,14]),
            clap:  pat(&[]),
            bass:  pat(&[0, 2, 4, 6, 8, 10, 12, 14]),
            notes: [E1,E1,G2,G2,A1,A1,C2,C2, E1,E1,G2,G2,A1,A1,D2,D2],
            bpm: 92.0,
            swing: 0.33,
        },
        // 4 — Bembe (Yoruba 6/8 standard bell): cross-rhythm against 4
        4 => Preset {
            kick:  pat(&[0, 6, 11]),
            snare: pat(&[3, 9]),
            hat:   pat(&[0, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15]),
            clap:  pat(&[5, 14]),
            bass:  pat(&[0, 6, 11]),
            notes: [A1,A1,A1,A1,A1,A1,C2,C2,C2,C2,C2,C2,D2,D2,D2,D2],
            bpm: 120.0,
            swing: 0.08,
        },
        // 5 — Deep Drum & Bass groove (slow, dubby — sub-bass focused)
        5 => Preset {
            kick:  pat(&[0, 6, 10]),
            snare: pat(&[4, 12]),
            hat:   pat(&[2, 6, 10, 14]),
            clap:  pat(&[]),
            bass:  pat(&[0, 3, 6, 10, 13]),
            notes: [A0,A0,A0,E1,E1,E1,A0,A0,A0,A0,C2,C2,C2,A0,A0,A0],
            bpm: 86.0,
            swing: 0.06,
        },
        // 0 / default — Free (no preset; user grid)
        _ => Preset {
            kick:  pat(&[0, 4, 8, 12]),
            snare: pat(&[4, 12]),
            hat:   pat(&[0, 2, 4, 6, 8, 10, 12, 14]),
            clap:  pat(&[]),
            bass:  pat(&[0, 8]),
            notes: [A1; 16],
            bpm: 96.0,
            swing: 0.0,
        },
    }
}
