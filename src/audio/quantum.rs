//! Quantum-inspired modulator.
//!
//! A tiny classical simulation of a 4-qubit circuit. Each "tick" runs:
//!   |0000> -> Hadamard on every wire -> CNOTs to entangle pairs -> phase rotation
//!   driven by an internal angle that drifts with `chaos`.
//! We then measure: the four single-qubit expectation values <Z_i> become four
//! correlated control signals in [-1, 1]. Output 0 drives smoothing; outputs 1..3
//! drive modulation depth, allowing "smooth" mixing at low chaos and entangled
//! signal chaos at high chaos.
//!
//! It's a small (16-dimensional complex state) classical simulator — fast enough
//! to step once per audio block.

#[derive(Clone, Copy)]
struct C { r: f32, i: f32 }

impl C {
    const ZERO: C = C { r: 0.0, i: 0.0 };
    #[inline] fn add(self, o: C) -> C { C { r: self.r + o.r, i: self.i + o.i } }
    #[inline] fn mul(self, o: C) -> C {
        C { r: self.r * o.r - self.i * o.i, i: self.r * o.i + self.i * o.r }
    }
    #[inline] fn scale(self, s: f32) -> C { C { r: self.r * s, i: self.i * s } }
    #[inline] fn abs2(self) -> f32 { self.r * self.r + self.i * self.i }
}

pub struct QuantumMod {
    state: [C; 16], // 4 qubits -> 16 basis states
    theta: f32,
    last: [f32; 4],
}

impl QuantumMod {
    pub fn new() -> Self {
        let mut state = [C::ZERO; 16];
        state[0] = C { r: 1.0, i: 0.0 };
        Self { state, theta: 0.0, last: [0.0; 4] }
    }

    fn hadamard(&mut self, q: usize) {
        let mask = 1usize << q;
        let inv_sqrt2 = std::f32::consts::FRAC_1_SQRT_2;
        let mut new = [C::ZERO; 16];
        for i in 0..16 {
            let j = i ^ mask;
            let (a, b) = if i & mask == 0 { (self.state[i], self.state[j]) }
                         else { (self.state[j], self.state[i]) };
            // |0> contribution -> (|0>+|1>)/sqrt2; |1> -> (|0>-|1>)/sqrt2
            if i & mask == 0 {
                new[i] = new[i].add(a.add(b).scale(inv_sqrt2));
            } else {
                new[i] = new[i].add(a.add(C { r: -b.r, i: -b.i }).scale(inv_sqrt2));
            }
        }
        self.state = new;
    }

    fn cnot(&mut self, control: usize, target: usize) {
        let cm = 1usize << control;
        let tm = 1usize << target;
        let mut new = self.state;
        for i in 0..16 {
            if i & cm != 0 {
                new[i] = self.state[i ^ tm];
            }
        }
        self.state = new;
    }

    fn phase(&mut self, q: usize, angle: f32) {
        let mask = 1usize << q;
        let (c, s) = (angle.cos(), angle.sin());
        let rot = C { r: c, i: s };
        for i in 0..16 {
            if i & mask != 0 {
                self.state[i] = self.state[i].mul(rot);
            }
        }
    }

    fn measure_z(&self, q: usize) -> f32 {
        // <Z_q> = sum p(|q=0>) - sum p(|q=1>)
        let mask = 1usize << q;
        let mut s = 0.0;
        for i in 0..16 {
            let p = self.state[i].abs2();
            if i & mask == 0 { s += p; } else { s -= p; }
        }
        s
    }

    /// Step the circuit. `chaos` 0..1 increases the drift, breaking smoothness.
    pub fn step(&mut self, chaos: f32) {
        // re-prepare |0000>
        for c in self.state.iter_mut() { *c = C::ZERO; }
        self.state[0] = C { r: 1.0, i: 0.0 };
        for q in 0..4 { self.hadamard(q); }
        self.cnot(0, 1);
        self.cnot(2, 3);
        self.cnot(1, 2);
        // chaos modulates the phase drift
        self.theta += 0.07 + chaos * 0.9;
        if self.theta > std::f32::consts::TAU { self.theta -= std::f32::consts::TAU; }
        for q in 0..4 {
            self.phase(q, self.theta * (1.0 + q as f32 * 0.31));
        }
        self.cnot(0, 2);
        self.cnot(1, 3);
        for q in 0..4 { self.last[q] = self.measure_z(q); }
    }

    /// Four correlated mod signals in [-1, 1].
    #[inline] pub fn out(&self) -> [f32; 4] { self.last }

    /// Smoothing coefficient: ranges 0.02 (very smooth) to 0.3 (responsive).
    /// `smooth` 0..1 from user. Quantum out[0] adds a little wobble.
    #[inline]
    pub fn smoothing_coef(&self, smooth: f32) -> f32 {
        let base = 0.02 + (1.0 - smooth.clamp(0.0, 1.0)) * 0.28;
        (base + self.last[0] * 0.02).clamp(0.005, 0.5)
    }
}
