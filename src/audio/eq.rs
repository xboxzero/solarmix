//! 3-band EQ using RBJ biquad cookbook filters.
//! Low shelf @ 200Hz, peaking mid @ 1kHz Q=0.8, high shelf @ 4kHz.

use std::f32::consts::PI;

#[derive(Default, Clone, Copy)]
struct Biquad {
    b0: f32, b1: f32, b2: f32,
    a1: f32, a2: f32,
    z1: f32, z2: f32,
}

impl Biquad {
    #[inline(always)]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    fn low_shelf(sr: f32, freq: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * freq / sr;
        let cos_w = w0.cos();
        let sin_w = w0.sin();
        let s = 1.0;
        let alpha = sin_w / 2.0 * ((a + 1.0/a) * (1.0/s - 1.0) + 2.0).sqrt();
        let sqrt_a_2alpha = 2.0 * a.sqrt() * alpha;

        let b0 = a * ((a + 1.0) - (a - 1.0) * cos_w + sqrt_a_2alpha);
        let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w);
        let b2 = a * ((a + 1.0) - (a - 1.0) * cos_w - sqrt_a_2alpha);
        let a0 = (a + 1.0) + (a - 1.0) * cos_w + sqrt_a_2alpha;
        let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos_w);
        let a2 = (a + 1.0) + (a - 1.0) * cos_w - sqrt_a_2alpha;

        Self { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0, z1: 0.0, z2: 0.0 }
    }

    fn high_shelf(sr: f32, freq: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * freq / sr;
        let cos_w = w0.cos();
        let sin_w = w0.sin();
        let s = 1.0;
        let alpha = sin_w / 2.0 * ((a + 1.0/a) * (1.0/s - 1.0) + 2.0).sqrt();
        let sqrt_a_2alpha = 2.0 * a.sqrt() * alpha;

        let b0 = a * ((a + 1.0) + (a - 1.0) * cos_w + sqrt_a_2alpha);
        let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w);
        let b2 = a * ((a + 1.0) + (a - 1.0) * cos_w - sqrt_a_2alpha);
        let a0 = (a + 1.0) - (a - 1.0) * cos_w + sqrt_a_2alpha;
        let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w);
        let a2 = (a + 1.0) - (a - 1.0) * cos_w - sqrt_a_2alpha;

        Self { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0, z1: 0.0, z2: 0.0 }
    }

    fn peaking(sr: f32, freq: f32, q: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * freq / sr;
        let cos_w = w0.cos();
        let sin_w = w0.sin();
        let alpha = sin_w / (2.0 * q);

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos_w;
        let a2 = 1.0 - alpha / a;

        Self { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0, z1: 0.0, z2: 0.0 }
    }
}

pub struct Eq3 {
    sr: f32,
    low: Biquad,
    mid: Biquad,
    high: Biquad,
}

impl Eq3 {
    pub fn new(sample_rate: u32) -> Self {
        let sr = sample_rate as f32;
        Self {
            sr,
            low: Biquad::low_shelf(sr, 200.0, 0.0),
            mid: Biquad::peaking(sr, 1000.0, 0.8, 0.0),
            high: Biquad::high_shelf(sr, 4000.0, 0.0),
        }
    }

    pub fn set_gains(&mut self, low_db: f32, mid_db: f32, high_db: f32) {
        // preserve state across coeff change
        let (lz1, lz2) = (self.low.z1, self.low.z2);
        let (mz1, mz2) = (self.mid.z1, self.mid.z2);
        let (hz1, hz2) = (self.high.z1, self.high.z2);
        self.low = Biquad::low_shelf(self.sr, 200.0, low_db);
        self.mid = Biquad::peaking(self.sr, 1000.0, 0.8, mid_db);
        self.high = Biquad::high_shelf(self.sr, 4000.0, high_db);
        self.low.z1 = lz1; self.low.z2 = lz2;
        self.mid.z1 = mz1; self.mid.z2 = mz2;
        self.high.z1 = hz1; self.high.z2 = hz2;
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        self.high.process(self.mid.process(self.low.process(x)))
    }
}
