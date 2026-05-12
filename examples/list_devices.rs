use cpal::traits::{DeviceTrait, HostTrait};

fn main() {
    let h = cpal::default_host();
    println!("=== INPUT DEVICES ===");
    if let Ok(it) = h.input_devices() {
        for d in it {
            let n = d.name().unwrap_or_default();
            match d.default_input_config() {
                Ok(c) => println!("  OK   {n} :: {c:?}"),
                Err(e) => println!("  ERR  {n} :: {e}"),
            }
        }
    }
    println!("=== OUTPUT DEVICES ===");
    if let Ok(it) = h.output_devices() {
        for d in it {
            let n = d.name().unwrap_or_default();
            match d.default_output_config() {
                Ok(c) => println!("  OK   {n} :: {c:?}"),
                Err(e) => println!("  ERR  {n} :: {e}"),
            }
        }
    }
}
