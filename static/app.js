// SolarMix front-end. Pure vanilla, Safari-friendly (no async/await chains that
// fight WebKit, no module imports — just one script tag).

(() => {
  const wsStatus = document.getElementById("ws-status");
  let ws = null;
  let queued = [];

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener("open", () => {
      wsStatus.textContent = "linked";
      while (queued.length) ws.send(queued.shift());
    });
    ws.addEventListener("close", () => {
      wsStatus.textContent = "lost — reconnecting…";
      setTimeout(connect, 1500);
    });
    ws.addEventListener("message", e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "tick") onTick(m);
    });
  }

  function send(obj) {
    const s = JSON.stringify(obj);
    if (ws && ws.readyState === 1) ws.send(s);
    else queued.push(s);
  }

  // ---------- knobs ----------
  document.querySelectorAll(".knob").forEach(setupKnob);

  function setupKnob(el) {
    const id = el.dataset.id;
    const min = parseFloat(el.dataset.min);
    const max = parseFloat(el.dataset.max);
    const def = parseFloat(el.dataset.default);
    const curve = el.dataset.curve || "lin";
    let value = def;

    const norm = v => {
      if (curve === "log") {
        const lmin = Math.log(min), lmax = Math.log(max);
        return (Math.log(v) - lmin) / (lmax - lmin);
      }
      return (v - min) / (max - min);
    };
    const denorm = n => {
      n = Math.max(0, Math.min(1, n));
      if (curve === "log") {
        const lmin = Math.log(min), lmax = Math.log(max);
        return Math.exp(lmin + n * (lmax - lmin));
      }
      return min + n * (max - min);
    };
    const render = () => {
      const n = norm(value);
      const deg = -135 + n * 270;
      el.style.setProperty("--deg", `${deg}deg`);
      el.style.transform = "";  // base rotation is on ::after via custom prop
      // we set the indicator rotation by writing a style rule on ::after via CSS var
      el.style.setProperty("--rot", deg + "deg");
      el.querySelector ? null : null;
      el.style.setProperty("transform", "");
      el.style.setProperty("--knob-rot", deg + "deg");
      // direct: animate via inline style on the rotated pseudo
      el.style.setProperty("--ang", deg + "deg");
      el.style.setProperty("transform", "");
      // simplest: rotate the entire knob (looks great with the indicator inside)
      el.style.transform = `rotate(${deg}deg)`;
    };
    render();

    let dragging = false;
    let startY = 0, startVal = 0;
    const start = e => {
      dragging = true;
      el.classList.add("dragging");
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      startY = y; startVal = value;
      e.preventDefault();
    };
    const move = e => {
      if (!dragging) return;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      const dy = startY - y; // up = positive
      const sens = e.shiftKey ? 600 : 220;
      let n = norm(startVal) + dy / sens;
      n = Math.max(0, Math.min(1, n));
      value = denorm(n);
      render();
      send({ type: "set", id, value });
      e.preventDefault();
    };
    const end = () => {
      dragging = false; el.classList.remove("dragging");
    };
    const dbl = () => { value = def; render(); send({ type: "set", id, value }); };

    el.addEventListener("mousedown", start);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    el.addEventListener("touchstart", start, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
    el.addEventListener("dblclick", dbl);
  }

  // ---------- toggles ----------
  document.querySelectorAll("[data-toggle]").forEach(b => {
    b.addEventListener("click", () => {
      b.classList.toggle("on");
      send({ type: "toggle", id: b.dataset.toggle });
    });
  });

  // ---------- waveform picker ----------
  document.querySelectorAll(".wave-btn").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".wave-btn").forEach(x => x.classList.remove("selected"));
      b.classList.add("selected");
      send({ type: "wave", value: parseInt(b.dataset.wave) });
    });
  });

  // ---------- drum grid ----------
  const VOICES = ["KICK", "SNARE", "HAT", "CLAP"];
  const DEFAULT_PATTERNS = [
    [0,4,8,12],   // kick
    [4,12],       // snare
    [0,2,4,6,8,10,12,14], // hat
    [],           // clap
  ];
  const grid = document.getElementById("drum-grid");
  const cells = [];
  for (let v = 0; v < 4; v++) {
    const lbl = document.createElement("div");
    lbl.className = "voice-label";
    lbl.textContent = VOICES[v];
    grid.appendChild(lbl);
    cells[v] = [];
    for (let s = 0; s < 16; s++) {
      const c = document.createElement("div");
      c.className = "step";
      if (DEFAULT_PATTERNS[v].includes(s)) c.classList.add("on");
      c.addEventListener("click", () => {
        c.classList.toggle("on");
        send({ type: "drum", voice: v, step: s });
      });
      grid.appendChild(c);
      cells[v].push(c);
    }
  }

  // ---------- looper ----------
  const recBtn = document.getElementById("loop-rec");
  const stopBtn = document.getElementById("loop-stop");
  const clearBtn = document.getElementById("loop-clear");
  recBtn.addEventListener("click", () => send({ type: "looper", action: "rec" }));
  stopBtn.addEventListener("click", () => send({ type: "looper", action: "stop" }));
  clearBtn.addEventListener("click", () => send({ type: "looper", action: "clear" }));

  // ---------- record ----------
  const recordBtn = document.getElementById("record-btn");
  let recording = false;
  recordBtn.addEventListener("click", () => {
    recording = !recording;
    recordBtn.classList.toggle("on", recording);
    send({ type: "record", on: recording });
  });

  // ---------- tick ----------
  const inBar = document.getElementById("in-bar");
  const outBar = document.getElementById("out-bar");
  const loopPos = document.getElementById("loop-pos-bar");
  const loopLabel = document.getElementById("loop-state-label");
  let curStep = -1;
  const LOOP_NAMES = ["idle", "recording", "playing", "overdub"];

  function onTick(m) {
    const ipct = Math.min(100, m.in_level * 600);
    const opct = Math.min(100, m.out_level * 600);
    inBar.style.width = ipct + "%";
    outBar.style.width = opct + "%";

    if (m.loop_pos >= 0) {
      loopPos.style.left = (m.loop_pos * 100) + "%";
    } else {
      loopPos.style.left = "-10px";
    }
    loopLabel.textContent = "LOOPER: " + LOOP_NAMES[m.looper];

    // drum step indicator
    if (m.drum_on && m.drum_step !== curStep) {
      for (let v = 0; v < 4; v++) {
        if (curStep >= 0) cells[v][curStep]?.classList.remove("cur");
        cells[v][m.drum_step]?.classList.add("cur");
      }
      curStep = m.drum_step;
    }
    if (!m.drum_on && curStep >= 0) {
      for (let v = 0; v < 4; v++) cells[v][curStep]?.classList.remove("cur");
      curStep = -1;
    }

    // sync toggle button visuals
    syncToggle("auto_mix", m.auto_mix);
    syncToggle("drum", m.drum_on);
    syncToggle("automation", m.automation);
    if (recordBtn.classList.contains("on") !== m.recording) {
      recording = m.recording;
      recordBtn.classList.toggle("on", recording);
    }
  }

  function syncToggle(id, on) {
    const b = document.querySelector(`[data-toggle="${id}"]`);
    if (b) b.classList.toggle("on", !!on);
  }

  connect();
})();
