//! Freeverb-style Schroeder reverb: 4 comb filters in parallel + 2 allpass in series.
//! Stereo, denormal-safe.

const COMB_TUNINGS: [usize; 4] = [1116, 1188, 1277, 1356];
const ALLPASS_TUNINGS: [usize; 2] = [556, 441];
const FIXED_GAIN: f32 = 0.015;

struct Comb {
    buf: Vec<f32>,
    idx: usize,
    feedback: f32,
    damp: f32,
    filter_store: f32,
}

impl Comb {
    fn new(size: usize) -> Self {
        Self { buf: vec![0.0; size], idx: 0, feedback: 0.84, damp: 0.4, filter_store: 0.0 }
    }
    #[inline(always)]
    fn process(&mut self, input: f32) -> f32 {
        let out = self.buf[self.idx];
        // damp = 1-pole lowpass in feedback path
        self.filter_store = out * (1.0 - self.damp) + self.filter_store * self.damp;
        self.buf[self.idx] = input + self.filter_store * self.feedback;
        self.idx = (self.idx + 1) % self.buf.len();
        // denormal squash
        if out.abs() < 1e-20 { 0.0 } else { out }
    }
}

struct Allpass {
    buf: Vec<f32>,
    idx: usize,
}

impl Allpass {
    fn new(size: usize) -> Self {
        Self { buf: vec![0.0; size], idx: 0 }
    }
    #[inline(always)]
    fn process(&mut self, input: f32) -> f32 {
        let buf_out = self.buf[self.idx];
        let out = -input + buf_out;
        self.buf[self.idx] = input + buf_out * 0.5;
        self.idx = (self.idx + 1) % self.buf.len();
        out
    }
}

pub struct Reverb {
    combs_l: Vec<Comb>,
    combs_r: Vec<Comb>,
    aps_l: Vec<Allpass>,
    aps_r: Vec<Allpass>,
}

impl Reverb {
    pub fn new() -> Self {
        Self {
            combs_l: COMB_TUNINGS.iter().map(|&n| Comb::new(n)).collect(),
            combs_r: COMB_TUNINGS.iter().map(|&n| Comb::new(n + 23)).collect(),
            aps_l: ALLPASS_TUNINGS.iter().map(|&n| Allpass::new(n)).collect(),
            aps_r: ALLPASS_TUNINGS.iter().map(|&n| Allpass::new(n + 23)).collect(),
        }
    }

    pub fn set_params(&mut self, size: f32, damp: f32) {
        // size 0..1 -> feedback 0.7..0.98
        let fb = 0.7 + size.clamp(0.0, 1.0) * 0.28;
        let damp = damp.clamp(0.0, 1.0) * 0.4;
        for c in self.combs_l.iter_mut().chain(self.combs_r.iter_mut()) {
            c.feedback = fb;
            c.damp = damp;
        }
    }

    /// Process mono input -> stereo output with wet/dry mix.
    #[inline]
    pub fn process(&mut self, input: f32, mix: f32) -> (f32, f32) {
        let inp = input * FIXED_GAIN;
        let mut wl = 0.0;
        let mut wr = 0.0;
        for c in &mut self.combs_l { wl += c.process(inp); }
        for c in &mut self.combs_r { wr += c.process(inp); }
        for a in &mut self.aps_l { wl = a.process(wl); }
        for a in &mut self.aps_r { wr = a.process(wr); }
        let dry = 1.0 - mix;
        (input * dry + wl * mix, input * dry + wr * mix)
    }
}
