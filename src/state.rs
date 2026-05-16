//! Lock-free shared state between the realtime audio thread and the web/control side.
//! All parameters are atomic; the audio thread reads with Relaxed ordering.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::Arc;

const REL: Ordering = Ordering::Relaxed;

pub struct AtomicF32(AtomicU32);

impl AtomicF32 {
    pub const fn new(v: f32) -> Self { Self(AtomicU32::new(v.to_bits())) }
    #[inline(always)] pub fn get(&self) -> f32 { f32::from_bits(self.0.load(REL)) }
    #[inline(always)] pub fn set(&self, v: f32) { self.0.store(v.to_bits(), REL); }
}

/// Qenet modes (Ethiopian pentatonic kiñit).
/// 1=Tezeta (nostalgic)  2=Bati (lively)  3=Ambassel (heroic)  4=Anchihoye (dramatic)
pub const MODE_TEZETA: u8 = 1;
pub const MODE_BATI: u8 = 2;
pub const MODE_AMBASSEL: u8 = 3;
pub const MODE_ANCHIHOYE: u8 = 4;

pub struct SharedState {
    // ---- master ----
    pub master_vol: AtomicF32,

    // ---- mode + root ----
    pub mode: AtomicU8,            // 1..4 (qenet)
    pub root_hz: AtomicF32,        // base pitch e.g. 220.0

    // ---- voices (4: 0=krar, 1=masinko, 2=washint, 3=kebero) ----
    pub voice_gate: [AtomicF32; 4],     // 0/1 trigger
    pub voice_pitch: [AtomicF32; 4],    // Hz target

    // ---- base routing matrix (4 voices × 4 buses) in [0..1] ----
    //  buses: 0=dry  1=reverb  2=delay  3=dark/lo-pass
    pub route: [AtomicF32; 16],

    // ---- qubit modulator ----
    pub chaos: AtomicF32,          // mixes base route ↔ qubit-derived route
    pub q_smooth: AtomicF32,       // smoothing for qubit motion

    // ---- FX ----
    pub reverb_mix: AtomicF32,
    pub reverb_size: AtomicF32,
    pub delay_time_ms: AtomicF32,
    pub delay_fb: AtomicF32,

    // ---- groove ----
    pub drum_enabled: AtomicBool,
    pub drum_bpm: AtomicF32,

    // ---- meters (RT thread -> UI) ----
    pub input_level: AtomicF32,
    pub output_level: AtomicF32,
    pub current_step: AtomicU8,
    pub recording: AtomicBool,

    // ---- snapshot of last 16 qubit coefficients for UI ----
    pub qcoef: [AtomicF32; 16],
}

impl SharedState {
    pub fn new() -> Arc<Self> {
        // Default routing: each voice → its "own" bus with a little overlap.
        // (v0=krar -> dry, v1=masinko -> reverb, v2=washint -> delay, v3=kebero -> dry)
        let mut r = [0.0_f32; 16];
        r[0 * 4 + 0] = 0.9; r[0 * 4 + 1] = 0.2;
        r[1 * 4 + 1] = 0.8; r[1 * 4 + 0] = 0.3;
        r[2 * 4 + 2] = 0.7; r[2 * 4 + 1] = 0.3;
        r[3 * 4 + 0] = 0.9; r[3 * 4 + 3] = 0.2;

        let route = std::array::from_fn(|i| AtomicF32::new(r[i]));
        Arc::new(Self {
            master_vol: AtomicF32::new(0.7),
            mode: AtomicU8::new(MODE_TEZETA),
            root_hz: AtomicF32::new(220.0),

            voice_gate: std::array::from_fn(|_| AtomicF32::new(0.0)),
            voice_pitch: std::array::from_fn(|_| AtomicF32::new(220.0)),

            route,

            chaos: AtomicF32::new(0.25),
            q_smooth: AtomicF32::new(0.7),

            reverb_mix: AtomicF32::new(0.25),
            reverb_size: AtomicF32::new(0.6),
            delay_time_ms: AtomicF32::new(360.0),
            delay_fb: AtomicF32::new(0.4),

            drum_enabled: AtomicBool::new(true),
            drum_bpm: AtomicF32::new(88.0),

            input_level: AtomicF32::new(0.0),
            output_level: AtomicF32::new(0.0),
            current_step: AtomicU8::new(0),
            recording: AtomicBool::new(false),

            qcoef: std::array::from_fn(|_| AtomicF32::new(0.0625)),
        })
    }
}
