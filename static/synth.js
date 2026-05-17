// tezeta Web Audio synth engine
// Replicates the four Pd voice generators: krar, masinko, washint, kebero

class TezetaSynth {
  constructor() {
    this.audioContext = null;
    this.masterGain = null;
    this.voices = [null, null, null, null];
    this.voiceGains = [null, null, null, null];
    this.isInitialized = false;
    this.sampleRate = 44100;
    this.queuedVoices = [];

    // Filter state for each voice (qubit-driven send levels)
    this.sendLevels = new Float32Array(16); // 4 voices × 4 buses
    this.busFilters = [null, null, null, null]; // dry, rev, dly, dark
  }

  async init() {
    if (this.isInitialized) return;

    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 44100,
      latencyHint: 'interactive',
    });
    this.sampleRate = this.audioContext.sampleRate;

    // Master output chain
    this.masterGain = this.audioContext.createGain();
    this.masterGain.gain.value = 0.7;
    this.masterGain.connect(this.audioContext.destination);

    // Create bus filters (dry pass-through, reverb, delay, dark)
    this.busFilters[0] = this.audioContext.createGain(); // dry
    this.busFilters[1] = this.createReverbBus();
    this.busFilters[2] = this.createDelayBus();
    this.busFilters[3] = this.createDarkBus();

    for (let i = 0; i < 4; i++) {
      this.busFilters[i].connect(this.masterGain);
    }

    // Create voice generators and routing
    const voiceClasses = [KrarVoice, MasinkoVoice, WashintVoice, KeberoVoice];
    for (let i = 0; i < 4; i++) {
      const voiceGain = this.audioContext.createGain();
      voiceGain.gain.value = 0.25;
      this.voiceGains[i] = voiceGain;

      // Route to all 4 buses via send levels
      for (let b = 0; b < 4; b++) {
        const sendGain = this.audioContext.createGain();
        sendGain.gain.value = this.sendLevels[i * 4 + b];
        voiceGain.connect(sendGain);
        sendGain.connect(this.busFilters[b]);
      }

      // Create voice and connect to voice gain
      this.voices[i] = new voiceClasses[i](this.audioContext, voiceGain);
    }

    this.isInitialized = true;
    console.log('Tezeta synth initialized:', this.audioContext.state);
  }

  createReverbBus() {
    const bus = this.audioContext.createGain();
    bus.gain.value = 0.25;
    // Simple reverb using convolver (placeholder - just a gain for now)
    return bus;
  }

  createDelayBus() {
    const bus = this.audioContext.createGain();
    const delay = this.audioContext.createDelay(5);
    const feedback = this.audioContext.createGain();
    delay.delayTime.value = 0.5;
    feedback.gain.value = 0.4;
    bus.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(bus);
    return bus;
  }

  createDarkBus() {
    const bus = this.audioContext.createGain();
    const filter = this.audioContext.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    bus.connect(filter);
    filter.connect(bus);
    return bus;
  }

  setGate(voice, gate) {
    if (!this.isInitialized) {
      this.queuedVoices.push({ voice, gate });
      return;
    }
    if (gate) {
      this.voices[voice]?.noteOn();
    } else {
      this.voices[voice]?.noteOff();
    }
  }

  setPitch(voice, hz) {
    if (!this.isInitialized) return;
    this.voices[voice]?.setPitch(hz);
  }

  setMaster(level) {
    if (!this.isInitialized) return;
    this.masterGain.gain.setTargetAtTime(level, this.audioContext.currentTime, 0.05);
  }

  setSendLevel(voice, bus, level) {
    if (!this.isInitialized) return;
    this.sendLevels[voice * 4 + bus] = level;
    // TODO: update send gain nodes
  }

  // Resume audio on user interaction (required by browser autoplay policy)
  async resume() {
    if (this.audioContext) {
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
    }
  }
}

// ============================================================================
// Voice generators
// ============================================================================

class KrarVoice {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.output = output;

    // Oscillator chain: phasor → -0.5 → *2 (triangle) → filter → vcf
    this.osc = ctx.createOscillator();
    this.osc.type = 'sine'; // we'll modulate to create triangle-like wave

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 4000;

    const vcf = ctx.createBiquadFilter();
    vcf.type = 'highpass';
    vcf.frequency.value = 2000;

    const envelope = this.createEnvelope(ctx);
    const gain = ctx.createGain();
    gain.gain.value = 0.5;

    this.osc.connect(lowpass);
    lowpass.connect(vcf);
    vcf.connect(envelope);
    envelope.connect(gain);
    gain.connect(output);

    this.osc.start(ctx.currentTime);
    this.envelope = envelope;
    this.vcf = vcf;
  }

  createEnvelope(ctx) {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    return gain;
  }

  setPitch(hz) {
    this.osc.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01);
  }

  noteOn() {
    this.envelope.gain.setTargetAtTime(1, this.ctx.currentTime, 0.01);
    this.vcf.frequency.setTargetAtTime(5000, this.ctx.currentTime, 0.05);
  }

  noteOff() {
    this.envelope.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    this.vcf.frequency.setTargetAtTime(1000, this.ctx.currentTime, 0.15);
  }
}

class MasinkoVoice {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.output = output;

    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';

    const vcf = ctx.createBiquadFilter();
    vcf.type = 'lowpass';
    vcf.frequency.value = 2200;
    vcf.Q.value = 8;

    const envelope = this.createEnvelope(ctx);
    const gain = ctx.createGain();
    gain.gain.value = 0.4;

    this.osc.connect(vcf);
    vcf.connect(envelope);
    envelope.connect(gain);
    gain.connect(output);

    this.osc.start(ctx.currentTime);
    this.envelope = envelope;
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'sine';
    this.osc2.frequency.value = 1; // 0.5% detuning
    this.osc2.connect(vcf);
    this.osc2.start(ctx.currentTime);
  }

  createEnvelope(ctx) {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    return gain;
  }

  setPitch(hz) {
    this.osc.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01);
    this.osc2.frequency.setTargetAtTime(hz * 1.005, this.ctx.currentTime, 0.01);
  }

  noteOn() {
    this.envelope.gain.setTargetAtTime(1, this.ctx.currentTime, 0.05);
  }

  noteOff() {
    this.envelope.gain.setTargetAtTime(0, this.ctx.currentTime, 0.8);
  }
}

class WashintVoice {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.output = output;

    const noise = ctx.createBufferSource();
    noise.buffer = this.createNoiseBuffer(ctx, 0.1);
    noise.loop = true;

    const bp1 = ctx.createBiquadFilter();
    bp1.type = 'bandpass';
    bp1.frequency.value = 800;
    bp1.Q.value = 6;

    const bp2 = ctx.createBiquadFilter();
    bp2.type = 'bandpass';
    bp2.frequency.value = 1200;
    bp2.Q.value = 8;

    const vcf = ctx.createBiquadFilter();
    vcf.type = 'highpass';
    vcf.frequency.value = 1000;

    const envelope = this.createEnvelope(ctx);
    const gain = ctx.createGain();
    gain.gain.value = 0.3;

    noise.connect(bp1);
    bp1.connect(vcf);
    bp2.connect(vcf);
    vcf.connect(envelope);
    envelope.connect(gain);
    gain.connect(output);

    noise.start(ctx.currentTime);
    this.noise = noise;
    this.envelope = envelope;
    this.vcf = vcf;
  }

  createNoiseBuffer(ctx, duration) {
    const rate = ctx.sampleRate;
    const length = rate * duration;
    const buffer = ctx.createAudioBuffer({ numberOfChannels: 1, length, sampleRate: rate });
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  setPitch(hz) {
    // Washint doesn't have pitch control, but we could modulate the filters
  }

  noteOn() {
    this.envelope.gain.setTargetAtTime(1, this.ctx.currentTime, 0.05);
    this.vcf.frequency.setTargetAtTime(5000, this.ctx.currentTime, 0.05);
  }

  noteOff() {
    this.envelope.gain.setTargetAtTime(0, this.ctx.currentTime, 0.6);
    this.vcf.frequency.setTargetAtTime(1000, this.ctx.currentTime, 0.6);
  }
}

class KeberoVoice {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.output = output;

    const noise = ctx.createBufferSource();
    noise.buffer = this.createNoiseBuffer(ctx, 0.1);
    noise.loop = true;

    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.value = 80;

    const hip = ctx.createBiquadFilter();
    hip.type = 'highpass';
    hip.frequency.value = 200;

    const lop = ctx.createBiquadFilter();
    lop.type = 'lowpass';
    lop.frequency.value = 6000;

    const envelope = this.createEnvelope(ctx);
    const gain = ctx.createGain();
    gain.gain.value = 0.7;

    noise.connect(hip);
    subOsc.connect(hip);
    hip.connect(lop);
    lop.connect(envelope);
    envelope.connect(gain);
    gain.connect(output);

    noise.start(ctx.currentTime);
    subOsc.start(ctx.currentTime);
    this.envelope = envelope;
  }

  createNoiseBuffer(ctx, duration) {
    const rate = ctx.sampleRate;
    const length = rate * duration;
    const buffer = ctx.createAudioBuffer({ numberOfChannels: 1, length, sampleRate: rate });
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  setPitch(hz) {
    // Kebero is a drum, pitch control could modulate sub-osc
  }

  noteOn() {
    this.envelope.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02);
  }

  noteOff() {
    this.envelope.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
  }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TezetaSynth };
}
