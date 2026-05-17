//! Pure Rust DSP synthesis engine for tezeta.
//! Implements 4 Ethiopian-mode voices: krar, masinko, washint, kebero.

use std::f32::consts::PI;

/// Fast sine approximation using Taylor series.
#[inline]
fn fast_sin(x: f32) -> f32 {
    let x = (x % (2.0 * PI) + 2.0 * PI) % (2.0 * PI);
    if x < PI {
        let xx = x * x;
        x * (1.0 - xx * (1.0/6.0 - xx * (1.0/120.0 - xx / 5040.0)))
    } else {
        let xx = (x - PI) * (x - PI);
        -(x - PI) * (1.0 - xx * (1.0/6.0 - xx * (1.0/120.0 - xx / 5040.0)))
    }
}

#[inline]
fn fast_cos(x: f32) -> f32 {
    fast_sin(x + PI / 2.0)
}

/// Sawtooth oscillator in [−1, 1].
#[inline]
fn sawtooth(phase: f32) -> f32 {
    2.0 * (phase - (phase + 0.5).floor())
}

/// Pseudorandom noise generator (LCG).
pub struct NoiseGen {
    seed: u32,
}

impl NoiseGen {
    pub fn new(seed: u32) -> Self { Self { seed } }
    pub fn next(&mut self) -> f32 {
        self.seed = self.seed.wrapping_mul(1664525).wrapping_add(1013904223);
        ((self.seed >> 8) as f32) / (1u32 << 24) as f32 * 2.0 - 1.0
    }
}

/// Linear envelope with attack, sustain, decay.
pub struct Envelope {
    attack_samples: u32,
    release_samples: u32,
    sample_count: u32,
    is_active: bool,
}

impl Envelope {
    pub fn new(attack_ms: f32, release_ms: f32, sr: f32) -> Self {
        Self {
            attack_samples: (attack_ms * sr / 1000.0) as u32,
            release_samples: (release_ms * sr / 1000.0) as u32,
            sample_count: 0,
            is_active: false,
        }
    }

    pub fn trigger(&mut self) {
        self.sample_count = 0;
        self.is_active = true;
    }

    pub fn release(&mut self) {
        self.sample_count = self.attack_samples;
    }

    pub fn next(&mut self) -> f32 {
        if !self.is_active {
            return 0.0;
        }

        let val = if self.sample_count < self.attack_samples {
            self.sample_count as f32 / self.attack_samples as f32
        } else {
            let release_pos = self.sample_count - self.attack_samples;
            if release_pos < self.release_samples {
                1.0 - (release_pos as f32 / self.release_samples as f32)
            } else {
                self.is_active = false;
                0.0
            }
        };

        self.sample_count += 1;
        val
    }
}

/// One-pole lowpass filter.
pub struct Lowpass {
    coeff: f32,
    prev: f32,
}

impl Lowpass {
    pub fn new(cutoff_hz: f32, sr: f32) -> Self {
        let coeff = 2.0 * PI * cutoff_hz / sr;
        Self { coeff: coeff / (coeff + 1.0), prev: 0.0 }
    }

    pub fn process(&mut self, input: f32) -> f32 {
        self.prev = self.coeff * input + (1.0 - self.coeff) * self.prev;
        self.prev
    }
}

/// Highpass filter (complement of lowpass).
pub struct Highpass {
    lp: Lowpass,
    prev_input: f32,
    prev_output: f32,
}

impl Highpass {
    pub fn new(cutoff_hz: f32, sr: f32) -> Self {
        Self {
            lp: Lowpass::new(cutoff_hz, sr),
            prev_input: 0.0,
            prev_output: 0.0,
        }
    }

    pub fn process(&mut self, input: f32) -> f32 {
        let lp_out = self.lp.process(input);
        let hp = input - lp_out;
        hp
    }
}

/// Simple resonant bandpass (peaks at center freq).
pub struct Bandpass {
    lp: Lowpass,
    hp: Highpass,
}

impl Bandpass {
    pub fn new(center_hz: f32, q: f32, sr: f32) -> Self {
        let bw = center_hz / q;
        Self {
            lp: Lowpass::new(center_hz + bw / 2.0, sr),
            hp: Highpass::new(center_hz - bw / 2.0, sr),
        }
    }

    pub fn process(&mut self, input: f32) -> f32 {
        let lp_out = self.lp.process(input);
        self.hp.process(lp_out)
    }
}

/// Freeverb reverb algorithm (simple 4-parallel comb + 2-series allpass).
pub struct Reverb {
    combs: [Comb; 4],
    allpasses: [Allpass; 2],
    wet_dry: f32,
}

struct Comb {
    buf: Vec<f32>,
    pos: usize,
    filter_state: f32,
    feedback: f32,
}

struct Allpass {
    buf: Vec<f32>,
    pos: usize,
    feedback: f32,
}

impl Reverb {
    pub fn new(sr: f32) -> Self {
        let lengths = [1116, 1188, 1277, 1356];
        let allpass_lens = [225, 556];
        Self {
            combs: [
                Comb::new(lengths[0]),
                Comb::new(lengths[1]),
                Comb::new(lengths[2]),
                Comb::new(lengths[3]),
            ],
            allpasses: [
                Allpass::new(allpass_lens[0]),
                Allpass::new(allpass_lens[1]),
            ],
            wet_dry: 0.0,
        }
    }

    pub fn set_params(&mut self, mix: f32, size: f32) {
        self.wet_dry = mix.clamp(0.0, 1.0);
        let feedback = 0.84 + size * 0.15;
        for c in &mut self.combs {
            c.feedback = feedback;
        }
    }

    pub fn process(&mut self, input: f32) -> f32 {
        let mut out = 0.0;
        for c in &mut self.combs {
            out += c.process(input);
        }
        out *= 0.25;
        for ap in &mut self.allpasses {
            out = ap.process(out);
        }
        out * self.wet_dry + input * (1.0 - self.wet_dry)
    }
}

impl Comb {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len], pos: 0, filter_state: 0.0, feedback: 0.84 }
    }

    fn process(&mut self, input: f32) -> f32 {
        let buf_out = self.buf[self.pos];
        self.filter_state = buf_out * 0.1 + self.filter_state * 0.9;
        self.buf[self.pos] = input + self.filter_state * self.feedback;
        self.pos = (self.pos + 1) % self.buf.len();
        buf_out
    }
}

impl Allpass {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len], pos: 0, feedback: 0.5 }
    }

    fn process(&mut self, input: f32) -> f32 {
        let buf_out = self.buf[self.pos];
        let out = -input + buf_out;
        self.buf[self.pos] = input + buf_out * self.feedback;
        self.pos = (self.pos + 1) % self.buf.len();
        out
    }
}

/// Delay line.
pub struct Delay {
    buf: Vec<f32>,
    write_pos: usize,
    feedback: f32,
    mix: f32,
}

impl Delay {
    pub fn new(max_ms: f32, sr: f32) -> Self {
        let len = ((max_ms * sr) / 1000.0) as usize;
        Self { buf: vec![0.0; len.max(1)], write_pos: 0, feedback: 0.4, mix: 0.3 }
    }

    pub fn set_params(&mut self, time_ms: f32, feedback: f32, sr: f32) {
        self.feedback = feedback.clamp(0.0, 0.95);
        self.mix = 0.3;
    }

    pub fn process(&mut self, input: f32, delay_ms: f32, sr: f32) -> f32 {
        let delay_samples = ((delay_ms * sr) / 1000.0) as usize % self.buf.len();
        let read_pos = (self.write_pos + self.buf.len() - delay_samples) % self.buf.len();

        let delayed = self.buf[read_pos];
        self.buf[self.write_pos] = input + delayed * self.feedback;
        self.write_pos = (self.write_pos + 1) % self.buf.len();

        input * (1.0 - self.mix) + delayed * self.mix
    }
}

/// Krar voice: sawtooth with harmonic content and filters.
pub struct KrarVoice {
    phase: f32,
    env: Envelope,
    lp1: Lowpass,
    lp2: Lowpass,
    vcf: Bandpass,
}

impl KrarVoice {
    pub fn new(sr: f32) -> Self {
        Self {
            phase: 0.0,
            env: Envelope::new(10.0, 1500.0, sr),
            lp1: Lowpass::new(4000.0, sr),
            lp2: Lowpass::new(4000.0, sr),
            vcf: Bandpass::new(2000.0, 2.0, sr),
        }
    }

    pub fn trigger(&mut self) { self.env.trigger(); }
    pub fn release(&mut self) { self.env.release(); }

    pub fn process(&mut self, pitch_hz: f32, sr: f32) -> f32 {
        let phase_inc = pitch_hz / sr;
        let saw = sawtooth(self.phase);
        self.phase = (self.phase + phase_inc) % 1.0;

        let filtered = self.lp1.process(saw);
        let filtered2 = self.vcf.process(filtered);

        filtered2 * self.env.next()
    }
}

/// Masinko voice: sine oscillator with slight feedback.
pub struct MasinkoVoice {
    phase: f32,
    env: Envelope,
    lp: Lowpass,
    feedback: f32,
}

impl MasinkoVoice {
    pub fn new(sr: f32) -> Self {
        Self {
            phase: 0.0,
            env: Envelope::new(10.0, 800.0, sr),
            lp: Lowpass::new(2200.0, sr),
            feedback: 0.0,
        }
    }

    pub fn trigger(&mut self) { self.env.trigger(); }
    pub fn release(&mut self) { self.env.release(); }

    pub fn process(&mut self, pitch_hz: f32, sr: f32) -> f32 {
        let phase_inc = pitch_hz / sr;
        let osc = fast_sin(self.phase * 2.0 * PI) * (1.0 + self.feedback * 0.005);
        self.phase = (self.phase + phase_inc) % 1.0;

        let filtered = self.lp.process(osc);
        filtered * self.env.next() * 0.6
    }
}

/// Washint voice: filtered noise.
pub struct WashintVoice {
    noise: NoiseGen,
    env: Envelope,
    bp1: Bandpass,
    bp2: Bandpass,
}

impl WashintVoice {
    pub fn new(sr: f32) -> Self {
        Self {
            noise: NoiseGen::new(12345),
            env: Envelope::new(50.0, 600.0, sr),
            bp1: Bandpass::new(800.0, 6.0, sr),
            bp2: Bandpass::new(1200.0, 8.0, sr),
        }
    }

    pub fn trigger(&mut self) { self.env.trigger(); }
    pub fn release(&mut self) { self.env.release(); }

    pub fn process(&mut self, _pitch_hz: f32) -> f32 {
        let noise = self.noise.next();
        let bp1 = self.bp1.process(noise);
        let bp2 = self.bp2.process(noise * 0.5);
        (bp1 + bp2) * self.env.next() * 0.3
    }
}

/// Kebero voice: noise-based drum/percussion.
pub struct KeberoVoice {
    noise: NoiseGen,
    env: Envelope,
    hp: Highpass,
    lp: Lowpass,
}

impl KeberoVoice {
    pub fn new(sr: f32) -> Self {
        Self {
            noise: NoiseGen::new(54321),
            env: Envelope::new(5.0, 400.0, sr),
            hp: Highpass::new(200.0, sr),
            lp: Lowpass::new(6000.0, sr),
        }
    }

    pub fn trigger(&mut self) { self.env.trigger(); }
    pub fn release(&mut self) { self.env.release(); }

    pub fn process(&mut self, _pitch_hz: f32) -> f32 {
        let noise = self.noise.next();
        let hp = self.hp.process(noise);
        let lp = self.lp.process(hp);
        lp * self.env.next() * 0.7
    }
}

/// Master synthesizer combining all voices.
pub struct TazetaSynth {
    sr: f32,
    krar: KrarVoice,
    masinko: MasinkoVoice,
    washint: WashintVoice,
    kebero: KeberoVoice,
    reverb: Reverb,
    delay: Delay,
    test_phase: f32,
}

impl TazetaSynth {
    pub fn new(sr: f32) -> Self {
        Self {
            sr,
            krar: KrarVoice::new(sr),
            masinko: MasinkoVoice::new(sr),
            washint: WashintVoice::new(sr),
            kebero: KeberoVoice::new(sr),
            reverb: Reverb::new(sr),
            delay: Delay::new(1500.0, sr),
            test_phase: 0.0,
        }
    }

    pub fn trigger_voice(&mut self, voice_idx: usize) {
        match voice_idx {
            0 => self.krar.trigger(),
            1 => self.masinko.trigger(),
            2 => self.washint.trigger(),
            3 => self.kebero.trigger(),
            _ => {}
        }
    }

    pub fn release_voice(&mut self, voice_idx: usize) {
        match voice_idx {
            0 => self.krar.release(),
            1 => self.masinko.release(),
            2 => self.washint.release(),
            3 => self.kebero.release(),
            _ => {}
        }
    }

    pub fn set_reverb(&mut self, mix: f32, size: f32) {
        self.reverb.set_params(mix, size);
    }

    pub fn set_delay(&mut self, time_ms: f32, feedback: f32) {
        self.delay.set_params(time_ms, feedback, self.sr);
    }

    pub fn process(&mut self, pitches: &[f32; 4]) -> f32 {
        // TEMPORARY: Test sine wave at 440 Hz
        let test_freq = 440.0;
        let phase_inc = test_freq / self.sr;
        let test_sine = fast_sin(self.test_phase * 2.0 * PI) * 0.3;
        self.test_phase = (self.test_phase + phase_inc) % 1.0;

        let k = self.krar.process(pitches[0], self.sr) * 2.0;
        let m = self.masinko.process(pitches[1], self.sr) * 2.0;
        let w = self.washint.process(pitches[2]) * 2.0;
        let kb = self.kebero.process(pitches[3]) * 2.0;

        let out = (k + m + w + kb) * 0.25 + test_sine * 0.5;

        let with_delay = self.delay.process(out, 360.0, self.sr);
        self.reverb.process(with_delay)
    }
}
