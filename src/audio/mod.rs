pub mod engine;
pub mod reverb;
pub mod delay;
pub mod eq;
pub mod drums;
pub mod recorder;
pub mod quantum;
pub mod experiment;
pub mod simd;

pub const SAMPLE_RATE: u32 = 48_000;
pub const BUFFER_SIZE: u32 = 512;
