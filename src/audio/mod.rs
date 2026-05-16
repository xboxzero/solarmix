//! Audio engine: cpal output stream → libpd processes every block. No DSP
//! lives in Rust anymore — the Pd patch owns the signal. Recorder.rs taps the
//! mixed output for WAV capture.

pub mod engine;
pub mod recorder;

pub const SAMPLE_RATE: u32 = 48_000;
pub const BUFFER_SIZE: u32 = 256;
