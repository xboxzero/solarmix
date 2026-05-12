//! Tiny synthesized drum machine — 4 voices (kick, snare, hat, clap) on a 16-step grid.
//! Each voice is one-shot synthesis, no samples required.

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
    }
    #[inline]
    fn process(&mut self, sr: f32, rng: &mut u32) -> f32 {
        if self.env < 1e-6 { return 0.0; }
        // xorshift noise
        *rng ^= *rng << 13;
        *rng ^= *rng >> 17;
        *rng ^= *rng << 5;
        let noise = (*rng as f32 / u32::MAX as f32) * 2.0 - 1.0;

        // pitch drop envelope (exponential)
        self.pitch_drop *= 0.9985;
        let f = self.pitch + self.pitch_drop * self.pitch_drop_amt;
        self.phase += TAU * f / sr;
        if self.phase > TAU { self.phase -= TAU; }
        let body = self.phase.sin();
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
    voices: [Voice; 4],
    rng: u32,
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
        }
    }

    pub fn set_bpm(&mut self, bpm: f32) {
        let bpm = bpm.clamp(40.0, 240.0);
        // 16ths => 4 steps per beat
        self.samples_per_step = self.sample_rate * 60.0 / (bpm * 4.0);
    }

    #[allow(dead_code)]
    pub fn current_step(&self) -> u8 { self.current_step }

    /// Advance one sample. `pattern[v]` is a 16-bit mask, bit 15 = step 0.
    #[inline]
    pub fn process(&mut self, pattern: &[u16; 4]) -> f32 {
        self.step_counter += 1.0;
        if self.step_counter >= self.samples_per_step {
            self.step_counter -= self.samples_per_step;
            self.current_step = (self.current_step + 1) & 15;
            let step = self.current_step as usize;
            // kick
            if (pattern[0] >> (15 - step)) & 1 == 1 {
                self.voices[0].trigger(55.0, 0.99975, 1.0, 0.04, 1.0);
            }
            // snare
            if (pattern[1] >> (15 - step)) & 1 == 1 {
                self.voices[1].trigger(200.0, 0.9994, 0.3, 0.7, 0.4);
            }
            // hat
            if (pattern[2] >> (15 - step)) & 1 == 1 {
                self.voices[2].trigger(8000.0, 0.998, 0.0, 1.0, 0.0);
            }
            // clap
            if (pattern[3] >> (15 - step)) & 1 == 1 {
                self.voices[3].trigger(1500.0, 0.9985, 0.0, 0.9, 0.1);
            }
        }
        let mut out = 0.0;
        for v in &mut self.voices {
            out += v.process(self.sample_rate, &mut self.rng);
        }
        out * 0.5
    }
}
