//! Audio engine: cpal output stream → pure Rust DSP processes every block.
//! Recorder.rs taps the mixed output for WAV capture.

pub mod dsp;
pub mod engine;
pub mod recorder;

pub const SAMPLE_RATE: u32 = 48_000;
pub const BUFFER_SIZE: u32 = 256;
