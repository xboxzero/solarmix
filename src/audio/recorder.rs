//! WAV recorder. The audio thread pushes samples into a ring buffer; a worker
//! task drains it to disk so file I/O never blocks the realtime callback.

use crossbeam::channel::{bounded, Receiver, Sender};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::path::PathBuf;
use std::thread;

pub struct Recorder {
    tx: Sender<RecMsg>,
}

enum RecMsg {
    Start(PathBuf),
    Frame(f32, f32),
    Stop,
}

impl Recorder {
    pub fn spawn(sample_rate: u32) -> Self {
        let (tx, rx): (Sender<RecMsg>, Receiver<RecMsg>) = bounded(1 << 16);
        thread::spawn(move || writer_thread(sample_rate, rx));
        Self { tx }
    }

    pub fn start(&self, path: PathBuf) {
        let _ = self.tx.try_send(RecMsg::Start(path));
    }

    #[inline]
    pub fn push(&self, l: f32, r: f32) {
        // try_send: if the queue is full we drop (better than blocking RT)
        let _ = self.tx.try_send(RecMsg::Frame(l, r));
    }

    pub fn stop(&self) {
        let _ = self.tx.try_send(RecMsg::Stop);
    }
}

fn writer_thread(sample_rate: u32, rx: Receiver<RecMsg>) {
    let spec = WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer: Option<WavWriter<std::io::BufWriter<std::fs::File>>> = None;
    while let Ok(msg) = rx.recv() {
        match msg {
            RecMsg::Start(path) => {
                if let Some(w) = writer.take() { let _ = w.finalize(); }
                if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
                match WavWriter::create(&path, spec) {
                    Ok(w) => {
                        tracing::info!("recording to {}", path.display());
                        writer = Some(w);
                    }
                    Err(e) => tracing::error!("cannot open wav: {e}"),
                }
            }
            RecMsg::Frame(l, r) => {
                if let Some(w) = writer.as_mut() {
                    let li = (l.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                    let ri = (r.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                    let _ = w.write_sample(li);
                    let _ = w.write_sample(ri);
                }
            }
            RecMsg::Stop => {
                if let Some(w) = writer.take() {
                    let _ = w.finalize();
                    tracing::info!("recording stopped");
                }
            }
        }
    }
}
