//! Experimental frequency generator — sine/tri/saw/square + noise.
//! Drives unusual mod sources into the chain.

use std::f32::consts::TAU;

pub struct Experiment {
    phase: f32,
    sr: f32,
    rng: u32,
}

impl Experiment {
    pub fn new(sample_rate: u32) -> Self {
        Self { phase: 0.0, sr: sample_rate as f32, rng: 0xDECAFBAD }
    }

    #[inline]
    pub fn process(&mut self, freq: f32, amp: f32, waveform: u8) -> f32 {
        if amp < 1e-5 { return 0.0; }
        if waveform == 4 {
            self.rng ^= self.rng << 13;
            self.rng ^= self.rng >> 17;
            self.rng ^= self.rng << 5;
            return ((self.rng as f32 / u32::MAX as f32) * 2.0 - 1.0) * amp;
        }
        self.phase += TAU * freq / self.sr;
        if self.phase > TAU { self.phase -= TAU; }
        let p = self.phase / TAU; // 0..1
        let s = match waveform {
            1 => 1.0 - (p * 2.0 - 1.0).abs() * 2.0,           // triangle
            2 => p * 2.0 - 1.0,                                // saw
            3 => if p < 0.5 { 1.0 } else { -1.0 },             // square
            _ => self.phase.sin(),                             // sine
        };
        s * amp
    }
}
