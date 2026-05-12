//! Hot DSP kernels.
//!
//! On aarch64 (Raspberry Pi 5) these use NEON intrinsics from `std::arch::aarch64`,
//! which the compiler emits as ARMv8 NEON assembly (FMLA, FMUL, FADD on 128-bit
//! float vectors — 4 floats per instruction). A scalar fallback handles other
//! targets so the crate still compiles on dev machines.
//!
//! See `cargo asm` / `objdump -d` on the release binary to inspect generated asm.

#[cfg(target_arch = "aarch64")]
use std::arch::aarch64::*;

/// Apply gain to `buf` in-place. Equivalent to `for x in buf { *x *= g }`.
#[inline]
pub fn gain_in_place(buf: &mut [f32], g: f32) {
    #[cfg(target_arch = "aarch64")]
    unsafe {
        let gv = vdupq_n_f32(g);
        let len = buf.len();
        let tail = len - (len % 4);
        let mut i = 0;
        while i < tail {
            let p = buf.as_mut_ptr().add(i);
            let v = vld1q_f32(p);
            vst1q_f32(p, vmulq_f32(v, gv));
            i += 4;
        }
        for k in tail..len { buf[k] *= g; }
        return;
    }
    #[cfg(not(target_arch = "aarch64"))]
    for x in buf { *x *= g; }
}

/// out += in * g, vectorised
#[allow(dead_code)]
#[inline]
pub fn mix_add(out: &mut [f32], inp: &[f32], g: f32) {
    let n = out.len().min(inp.len());
    #[cfg(target_arch = "aarch64")]
    unsafe {
        let gv = vdupq_n_f32(g);
        let mut i = 0;
        while i + 4 <= n {
            let op = out.as_mut_ptr().add(i);
            let ip = inp.as_ptr().add(i);
            let ov = vld1q_f32(op);
            let iv = vld1q_f32(ip);
            vst1q_f32(op, vfmaq_f32(ov, iv, gv));
            i += 4;
        }
        for k in i..n { out[k] += inp[k] * g; }
        return;
    }
    #[cfg(not(target_arch = "aarch64"))]
    for k in 0..n { out[k] += inp[k] * g; }
}

/// Compute sum-of-squares for RMS metering.
#[allow(dead_code)]
#[inline]
pub fn sum_sq(buf: &[f32]) -> f32 {
    #[cfg(target_arch = "aarch64")]
    unsafe {
        let mut acc = vdupq_n_f32(0.0);
        let mut i = 0;
        while i + 4 <= buf.len() {
            let v = vld1q_f32(buf.as_ptr().add(i));
            acc = vfmaq_f32(acc, v, v);
            i += 4;
        }
        let mut s = vgetq_lane_f32(acc, 0) + vgetq_lane_f32(acc, 1)
                  + vgetq_lane_f32(acc, 2) + vgetq_lane_f32(acc, 3);
        for k in i..buf.len() { s += buf[k] * buf[k]; }
        return s;
    }
    #[cfg(not(target_arch = "aarch64"))]
    {
        let mut s = 0.0;
        for &x in buf { s += x * x; }
        s
    }
}
