//! Variable-length looper with overdub. Max ~30 seconds at 48kHz stereo.

use crate::state::LooperState;

pub struct Looper {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    length: usize, // 0 = empty, else committed length in samples
    pos: usize,
    capacity: usize,
}

impl Looper {
    pub fn new(sample_rate: u32, max_seconds: f32) -> Self {
        let cap = (sample_rate as f32 * max_seconds) as usize;
        Self {
            buf_l: vec![0.0; cap],
            buf_r: vec![0.0; cap],
            length: 0,
            pos: 0,
            capacity: cap,
        }
    }

    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.buf_l.fill(0.0);
        self.buf_r.fill(0.0);
        self.length = 0;
        self.pos = 0;
    }

    pub fn position_norm(&self) -> f32 {
        if self.length == 0 { -1.0 } else { self.pos as f32 / self.length as f32 }
    }

    /// One sample per call. Input l/r is the dry signal from the engine;
    /// returns the loop playback for mixing.
    #[inline]
    pub fn process(&mut self, state: LooperState, in_l: f32, in_r: f32) -> (f32, f32) {
        match state {
            LooperState::Idle => (0.0, 0.0),
            LooperState::Recording => {
                if self.pos >= self.capacity {
                    self.length = self.capacity;
                    return (0.0, 0.0);
                }
                self.buf_l[self.pos] = in_l;
                self.buf_r[self.pos] = in_r;
                self.pos += 1;
                self.length = self.pos;
                (0.0, 0.0)
            }
            LooperState::Playing => {
                if self.length == 0 { return (0.0, 0.0); }
                let l = self.buf_l[self.pos];
                let r = self.buf_r[self.pos];
                self.pos += 1;
                if self.pos >= self.length { self.pos = 0; }
                (l, r)
            }
            LooperState::Overdub => {
                if self.length == 0 { return (0.0, 0.0); }
                let l = self.buf_l[self.pos];
                let r = self.buf_r[self.pos];
                self.buf_l[self.pos] = (l + in_l).clamp(-1.0, 1.0);
                self.buf_r[self.pos] = (r + in_r).clamp(-1.0, 1.0);
                self.pos += 1;
                if self.pos >= self.length { self.pos = 0; }
                (l, r)
            }
        }
    }
}
