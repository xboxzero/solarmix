//! Stereo ping-pong tape delay with smoothed read position to avoid clicks
//! when the delay time changes.

pub struct Delay {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write_idx: usize,
    sample_rate: f32,
    read_offset: f32, // smoothed delay length in samples
    target_offset: f32,
}

impl Delay {
    pub fn new(sample_rate: u32, max_seconds: f32) -> Self {
        let cap = (sample_rate as f32 * max_seconds) as usize;
        Self {
            buf_l: vec![0.0; cap],
            buf_r: vec![0.0; cap],
            write_idx: 0,
            sample_rate: sample_rate as f32,
            read_offset: 19200.0,
            target_offset: 19200.0,
        }
    }

    pub fn set_time_ms(&mut self, ms: f32) {
        let samp = (ms * 0.001 * self.sample_rate).max(1.0);
        self.target_offset = samp.min(self.buf_l.len() as f32 - 2.0);
    }

    /// Process mono input -> stereo (ping-pong). Returns wet+dry mix.
    #[inline]
    pub fn process(&mut self, input: f32, feedback: f32, mix: f32) -> (f32, f32) {
        // smooth offset toward target (5ms time constant)
        self.read_offset += (self.target_offset - self.read_offset) * 0.0005;
        let cap = self.buf_l.len();
        let read_pos_f = (self.write_idx as f32 + cap as f32 - self.read_offset) % cap as f32;
        let i0 = read_pos_f.floor() as usize % cap;
        let i1 = (i0 + 1) % cap;
        let frac = read_pos_f - read_pos_f.floor();

        let wl = self.buf_l[i0] * (1.0 - frac) + self.buf_l[i1] * frac;
        let wr = self.buf_r[i0] * (1.0 - frac) + self.buf_r[i1] * frac;

        // ping-pong: write right-tap into left buffer next cycle
        let fb = feedback.clamp(0.0, 0.95);
        self.buf_l[self.write_idx] = input + wr * fb;
        self.buf_r[self.write_idx] = wl * fb;
        self.write_idx = (self.write_idx + 1) % cap;

        let dry = 1.0 - mix * 0.5; // delay is additive
        (input * dry + wl * mix, input * dry + wr * mix)
    }
}
