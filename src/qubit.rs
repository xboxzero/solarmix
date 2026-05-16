//! Multiplied qubit router: tensor product of 4 single-qubit states gives 16
//! entangled real coefficients in [0..1]. These drive the 4×4 patchbay routing
//! matrix (4 voices × 4 buses) inside the Pd patch.
//!
//! Each qubit is a slowly-evolving phase angle θ_i; the per-output coefficient
//! is |⟨b₃b₂b₁b₀|ψ⟩|² where |ψ⟩ = ⨂ᵢ (cos θᵢ |0⟩ + e^{iφᵢ} sin θᵢ |1⟩). With
//! chaos > 0 the phase angles drift; at chaos = 0 they freeze and the matrix
//! is static (everything routes "as configured").

use std::f32::consts::TAU;

#[derive(Clone, Copy)]
pub struct Qubit { pub theta: f32, pub phi: f32, pub drift_t: f32, pub drift_p: f32 }

pub struct QubitRouter {
    pub qubits: [Qubit; 4],
    pub coeffs: [f32; 16], // 4 voices × 4 buses, row-major: coeffs[v*4 + b]
    pub last_chaos: f32,
}

impl QubitRouter {
    pub fn new() -> Self {
        // Different drift rates per qubit keep the entanglement non-periodic.
        Self {
            qubits: [
                Qubit { theta: 0.4, phi: 0.0, drift_t: 0.013, drift_p: 0.027 },
                Qubit { theta: 0.9, phi: 1.0, drift_t: 0.021, drift_p: 0.041 },
                Qubit { theta: 1.2, phi: 2.0, drift_t: 0.034, drift_p: 0.019 },
                Qubit { theta: 0.7, phi: 3.0, drift_t: 0.011, drift_p: 0.053 },
            ],
            coeffs: [0.0625; 16],
            last_chaos: 0.0,
        }
    }

    /// Advance one tick (called from the audio thread once per Pd block, ~64
    /// samples). `chaos` ∈ [0..1] scales drift speed.
    pub fn step(&mut self, chaos: f32, dt: f32) {
        self.last_chaos = chaos;
        for q in self.qubits.iter_mut() {
            q.theta += q.drift_t * chaos * dt * TAU;
            q.phi   += q.drift_p * chaos * dt * TAU;
            if q.theta > TAU { q.theta -= TAU; }
            if q.phi   > TAU { q.phi   -= TAU; }
        }
        // Tensor product amplitudes: 16 basis states |b3 b2 b1 b0⟩.
        // Amplitude for bit b on qubit i: cos θᵢ if b=0 else (cos φᵢ + j sin φᵢ) sin θᵢ
        // We only need the squared magnitudes — phases cancel inside |a|².
        let mut sum = 0.0;
        for k in 0..16 {
            let mut a = 1.0_f32;
            for i in 0..4 {
                let q = self.qubits[i];
                let bit = (k >> i) & 1;
                a *= if bit == 0 { q.theta.cos().powi(2) } else { q.theta.sin().powi(2) };
            }
            self.coeffs[k] = a;
            sum += a;
        }
        // Normalize so probabilities sum to 1 (numerical drift insurance).
        if sum > 1e-9 {
            for c in self.coeffs.iter_mut() { *c /= sum; }
        }
    }

    /// Routing coefficient for (voice, bus), v∈0..4, b∈0..4. Returned in [0..1].
    /// Mixed with a per-user base routing matrix (1−chaos) * base + chaos * qubit.
    pub fn coeff(&self, voice: usize, bus: usize) -> f32 {
        self.coeffs[(voice * 4 + bus) & 0xF]
    }

    pub fn snapshot_16(&self) -> [f32; 16] { self.coeffs }
}
