//! Lock-free shared state between the realtime audio thread and the web/control side.
//!
//! All parameters are stored as `AtomicU32` holding the bits of an `f32`. The audio
//! thread reads with `Relaxed` ordering; the web thread writes with `Relaxed`.
//! No mutex is ever taken on the audio thread.

use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU8, Ordering};
use std::sync::Arc;

const REL: Ordering = Ordering::Relaxed;

pub struct AtomicF32(AtomicU32);

impl AtomicF32 {
    pub const fn new(v: f32) -> Self {
        Self(AtomicU32::new(v.to_bits()))
    }
    #[inline(always)]
    pub fn get(&self) -> f32 {
        f32::from_bits(self.0.load(REL))
    }
    #[inline(always)]
    pub fn set(&self, v: f32) {
        self.0.store(v.to_bits(), REL);
    }
}

pub struct SharedState {
    // master
    pub master_gain: AtomicF32,
    pub input_gain: AtomicF32,
    pub auto_mix: AtomicBool,
    pub auto_mix_target: AtomicF32,

    // reverb
    pub reverb_mix: AtomicF32,
    pub reverb_size: AtomicF32,
    pub reverb_damp: AtomicF32,

    // delay
    pub delay_time_ms: AtomicF32,
    pub delay_feedback: AtomicF32,
    pub delay_mix: AtomicF32,

    // 3-band EQ (dB)
    pub eq_low_db: AtomicF32,
    pub eq_mid_db: AtomicF32,
    pub eq_high_db: AtomicF32,

    // experimental frequency generator (driven by the 3D orb)
    pub exp_freq: AtomicF32,
    pub exp_amp: AtomicF32,
    pub exp_waveform: AtomicU8,

    // quantum modulator — drives the whole feel of the mix
    pub quantum_amount: AtomicF32,
    pub quantum_smooth: AtomicF32,

    // drum machine (5 voices: kick, snare, hat, clap, bass)
    pub drum_enabled: AtomicBool,
    pub drum_bpm: AtomicF32,
    pub drum_gain: AtomicF32,
    pub drum_pattern: [AtomicU16; 5],
    pub drum_preset: AtomicU8,       // 0=free, 1=Afrobeat, 2=Highlife, 3=Blues, 4=Bembe, 5=DnB
    pub drum_swing: AtomicF32,       // 0..0.5
    pub bass_gain: AtomicF32,
    // 16 bass note pitches (Hz) for the current preset
    pub bass_notes: [AtomicF32; 16],

    // recording
    pub recording: AtomicBool,

    // automation (LFO across all params)
    pub automation_enabled: AtomicBool,
    pub automation_rate: AtomicF32,

    // meters (RT thread -> UI)
    pub input_level: AtomicF32,
    pub output_level: AtomicF32,
    pub current_step: AtomicU8,      // for UI to highlight the current drum step
}

impl SharedState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            master_gain: AtomicF32::new(0.8),
            input_gain: AtomicF32::new(1.0),
            auto_mix: AtomicBool::new(true),
            auto_mix_target: AtomicF32::new(0.25),

            reverb_mix: AtomicF32::new(0.25),
            reverb_size: AtomicF32::new(0.7),
            reverb_damp: AtomicF32::new(0.4),

            delay_time_ms: AtomicF32::new(380.0),
            delay_feedback: AtomicF32::new(0.45),
            delay_mix: AtomicF32::new(0.2),

            eq_low_db: AtomicF32::new(0.0),
            eq_mid_db: AtomicF32::new(0.0),
            eq_high_db: AtomicF32::new(0.0),

            exp_freq: AtomicF32::new(220.0),
            exp_amp: AtomicF32::new(0.0),
            exp_waveform: AtomicU8::new(0),

            quantum_amount: AtomicF32::new(0.3),
            quantum_smooth: AtomicF32::new(0.7),

            drum_enabled: AtomicBool::new(true), // always-on by default — it can run forever
            drum_bpm: AtomicF32::new(96.0),
            drum_gain: AtomicF32::new(0.65),
            drum_pattern: [
                AtomicU16::new(0b1000_1000_1000_1000),
                AtomicU16::new(0b0000_1000_0000_1000),
                AtomicU16::new(0b1010_1010_1010_1010),
                AtomicU16::new(0),
                AtomicU16::new(0b1000_0000_1000_0000), // bass on 1 & 9
            ],
            drum_preset: AtomicU8::new(1), // Afrobeat by default
            drum_swing: AtomicF32::new(0.0),
            bass_gain: AtomicF32::new(0.7),
            bass_notes: [
                AtomicF32::new(55.0), AtomicF32::new(55.0), AtomicF32::new(55.0), AtomicF32::new(55.0),
                AtomicF32::new(55.0), AtomicF32::new(55.0), AtomicF32::new(55.0), AtomicF32::new(55.0),
                AtomicF32::new(55.0), AtomicF32::new(55.0), AtomicF32::new(55.0), AtomicF32::new(55.0),
                AtomicF32::new(55.0), AtomicF32::new(55.0), AtomicF32::new(55.0), AtomicF32::new(55.0),
            ],

            recording: AtomicBool::new(false),

            automation_enabled: AtomicBool::new(false),
            automation_rate: AtomicF32::new(0.15),

            input_level: AtomicF32::new(0.0),
            output_level: AtomicF32::new(0.0),
            current_step: AtomicU8::new(0),
        })
    }

    #[allow(dead_code)]
    pub fn drum_step(&self, voice: usize, step: usize) -> bool {
        let pat = self.drum_pattern[voice].load(REL);
        (pat >> (15 - step)) & 1 == 1
    }

    pub fn toggle_drum_step(&self, voice: usize, step: usize) {
        let bit = 1u16 << (15 - step);
        let cur = self.drum_pattern[voice].load(REL);
        self.drum_pattern[voice].store(cur ^ bit, REL);
    }

    /// Apply a preset by index, updating patterns, BPM, swing, and bass notes.
    pub fn apply_preset(&self, idx: u8) {
        let p = crate::audio::drums::preset(idx);
        self.drum_preset.store(idx, REL);
        self.drum_pattern[0].store(p.kick, REL);
        self.drum_pattern[1].store(p.snare, REL);
        self.drum_pattern[2].store(p.hat, REL);
        self.drum_pattern[3].store(p.clap, REL);
        self.drum_pattern[4].store(p.bass, REL);
        self.drum_bpm.set(p.bpm);
        self.drum_swing.set(p.swing);
        for (i, n) in p.notes.iter().enumerate() {
            self.bass_notes[i].set(*n);
        }
    }
}
