#[path = "src/audio/dsp.rs"]
mod dsp;

use dsp::TazetaSynth;

fn main() {
    let sr = 44100.0;
    let mut synth = TazetaSynth::new(sr);
    
    // Trigger voice 0 (krar)
    synth.trigger_voice(0);
    let pitches = [220.0, 0.0, 0.0, 0.0];
    
    // Generate 1000 samples
    let mut max_sample = 0.0f32;
    for _ in 0..1000 {
        let sample = synth.process(&pitches);
        max_sample = max_sample.max(sample.abs());
    }
    
    println!("Max sample amplitude: {:.6}", max_sample);
    
    // Release voice
    synth.release_voice(0);
    
    for _ in 0..1000 {
        let sample = synth.process(&pitches);
        max_sample = max_sample.max(sample.abs());
    }
    
    println!("Max sample after release: {:.6}", max_sample);
}
