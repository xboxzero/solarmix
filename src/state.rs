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

#[repr(u8)]
#[derive(Copy, Clone, Debug)]
pub enum LooperState {
    Idle = 0,
    Recording = 1,
    Playing = 2,
    Overdub = 3,
}

pub struct SharedState {
    // master
    pub master_gain: AtomicF32,
    pub input_gain: AtomicF32,
    pub auto_mix: AtomicBool,
    pub auto_mix_target: AtomicF32, // target RMS for auto gain

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

    // experimental frequency generator
    pub exp_freq: AtomicF32,
    pub exp_amp: AtomicF32,
    pub exp_waveform: AtomicU8, // 0=sine, 1=tri, 2=saw, 3=square, 4=noise

    // quantum modulator
    pub quantum_amount: AtomicF32, // 0..1
    pub quantum_smooth: AtomicF32, // 0..1, blends raw->smoothed params

    // drum machine
    pub drum_enabled: AtomicBool,
    pub drum_bpm: AtomicF32,
    pub drum_gain: AtomicF32,
    pub drum_pattern: [AtomicU16; 4], // 16 step bitmask per voice (kick/snare/hat/clap)

    // looper
    pub looper_state: AtomicU8,
    pub looper_gain: AtomicF32,

    // recording
    pub recording: AtomicBool,

    // automation (LFO across all params)
    pub automation_enabled: AtomicBool,
    pub automation_rate: AtomicF32,

    // meters (RT thread -> UI)
    pub input_level: AtomicF32,
    pub output_level: AtomicF32,
    pub loop_position: AtomicF32, // 0..1 if playing, else -1
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

            drum_enabled: AtomicBool::new(false),
            drum_bpm: AtomicF32::new(96.0),
            drum_gain: AtomicF32::new(0.7),
            drum_pattern: [
                AtomicU16::new(0b1000_1000_1000_1000), // kick on 1,5,9,13
                AtomicU16::new(0b0000_1000_0000_1000), // snare on 5,13
                AtomicU16::new(0b1010_1010_1010_1010), // hat on every other 8th
                AtomicU16::new(0),
            ],

            looper_state: AtomicU8::new(LooperState::Idle as u8),
            looper_gain: AtomicF32::new(0.8),

            recording: AtomicBool::new(false),

            automation_enabled: AtomicBool::new(false),
            automation_rate: AtomicF32::new(0.15), // Hz

            input_level: AtomicF32::new(0.0),
            output_level: AtomicF32::new(0.0),
            loop_position: AtomicF32::new(-1.0),
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

    pub fn looper_state(&self) -> LooperState {
        match self.looper_state.load(REL) {
            1 => LooperState::Recording,
            2 => LooperState::Playing,
            3 => LooperState::Overdub,
            _ => LooperState::Idle,
        }
    }

    pub fn set_looper_state(&self, s: LooperState) {
        self.looper_state.store(s as u8, REL);
    }
}
