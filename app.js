const STORAGE_KEY = "dt-pace-v4";
const HOUR_MS = 60 * 60 * 1000;

const els = {
  app: document.getElementById("app"),
  clock: document.getElementById("clock"),
  shiftLabel: document.getElementById("shift-label"),
  carChip: document.getElementById("car-chip"),
  sosTime: document.getElementById("sos-time"),
  sosHint: document.getElementById("sos-hint"),
  depTime: document.getElementById("dep-time"),
  depStatus: document.getElementById("dep-status"),
  depMeter: document.getElementById("dep-meter"),
  tickCaution: document.getElementById("tick-caution"),
  tickWarn: document.getElementById("tick-warn"),
  historyList: document.getElementById("history-list"),
  hourly: document.getElementById("hourly"),
  paceChip: document.getElementById("pace-chip"),
  statCars: document.getElementById("stat-cars"),
  statDep: document.getElementById("stat-dep"),
  statOk: document.getElementById("stat-ok"),
  primaryBtn: document.getElementById("primary-btn"),
  primaryLabel: document.getElementById("primary-label"),
  primaryHint: document.getElementById("primary-hint"),
  undoBtn: document.getElementById("undo-btn"),
  muteBtn: document.getElementById("mute-btn"),
  voiceBtn: document.getElementById("voice-btn"),
  menuBtn: document.getElementById("menu-btn"),
  menuDone: document.getElementById("menu-done"),
  settingsBtn: document.getElementById("settings-btn"),
  resetBtn: document.getElementById("reset-btn"),
  exportBtn: document.getElementById("export-btn"),
  menuSheet: document.getElementById("menu-sheet"),
  settingsSheet: document.getElementById("settings-sheet"),
  settingsDone: document.getElementById("settings-done"),
  setGoal: document.getElementById("set-goal"),
  setCaution: document.getElementById("set-caution"),
  setWarn: document.getElementById("set-warn"),
  setLane1: document.getElementById("set-lane1"),
  setLane2: document.getElementById("set-lane2"),
  setClock12: document.getElementById("set-clock12"),
  lane1Btn: document.getElementById("lane-1-btn"),
  lane2Btn: document.getElementById("lane-2-btn"),
  lane1Time: document.getElementById("lane-1-time"),
  lane2Time: document.getElementById("lane-2-time"),
};

const defaultSettings = () => ({
  windowGoal: 30,
  cautionAt: 25,
  warnAt: 27,
  laneNames: ["Lane 1", "Lane 2"],
  clock12: true,
  muted: false,
  voice: true,
});

const emptyLane = () => ({ queue: [], windowCar: null });

const state = {
  nextNumber: 1,
  activeLane: 1,
  lanes: { 1: emptyLane(), 2: emptyLane() },
  history: [],
  startedAt: Date.now(),
  settings: defaultSettings(),
  audio: null,
  wakeLock: null,
  lastLateBeep: { 1: 0, 2: 0 },
  lastVoice: { 1: "", 2: "" },
};

function now() {
  return Date.now();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatClock(date, clock12) {
  let hours = date.getHours();
  const minutes = pad(date.getMinutes());
  if (!clock12) return `${pad(hours)}:${minutes}`;
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${suffix}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

function reviveCar(car) {
  return { ...car, fired: new Set(car.fired || []) };
}

function cloneLane(lane) {
  return {
    queue: (lane.queue || []).map(reviveCar),
    windowCar: lane.windowCar ? reviveCar(lane.windowCar) : null,
  };
}

function serializeLane(lane) {
  return {
    queue: lane.queue.map((car) => ({ ...car, fired: [...car.fired] })),
    windowCar: lane.windowCar ? { ...lane.windowCar, fired: [...lane.windowCar.fired] } : null,
  };
}

function saveShift() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      nextNumber: state.nextNumber,
      activeLane: state.activeLane,
      lanes: { 1: serializeLane(state.lanes[1]), 2: serializeLane(state.lanes[2]) },
      history: state.history,
      startedAt: state.startedAt,
      settings: state.settings,
    })
  );
}

function loadShift() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.nextNumber = saved.nextNumber || 1;
    state.activeLane = saved.activeLane === 2 ? 2 : 1;
    state.lanes[1] = cloneLane(saved.lanes?.[1] || emptyLane());
    state.lanes[2] = cloneLane(saved.lanes?.[2] || emptyLane());
    state.history = saved.history || [];
    state.startedAt = saved.startedAt || Date.now();
    state.settings = { ...defaultSettings(), ...(saved.settings || {}) };
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function activeLane() {
  return state.lanes[state.activeLane];
}

function createCar() {
  return {
    id: crypto.randomUUID(),
    number: state.nextNumber++,
    lane: state.activeLane,
    arrivedAt: now(),
    windowAt: null,
    departedAt: null,
    fired: new Set(),
  };
}

function departureSeconds(car, at = now()) {
  if (!car?.windowAt) return 0;
  return (at - car.windowAt) / 1000;
}

function alertLevel(seconds) {
  const { cautionAt, warnAt, windowGoal } = state.settings;
  if (seconds >= windowGoal) return "late";
  if (seconds >= warnAt) return "warn";
  if (seconds >= cautionAt) return "caution";
  return "ok";
}

function haptic(ms = 20) {
  navigator.vibrate?.(ms);
}

async function keepAwake() {
  try {
    state.wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    /* unsupported or denied */
  }
}

function ensureAudio() {
  if (!state.audio) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) state.audio = new Ctx();
  }
  if (state.audio?.state === "suspended") state.audio.resume();
  keepAwake();
  return state.audio;
}

function tone(freq, start, length, type = "square", gain = 0.07) {
  const ctx = ensureAudio();
  if (!ctx || state.settings.muted) return;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  amp.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + start + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + length);
  osc.connect(amp);
  amp.connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + length + 0.02);
}

function playAlert(level) {
  if (level === "caution") {
    tone(880, 0, 0.12);
    tone(880, 0.18, 0.12);
  } else if (level === "warn") {
    tone(1040, 0, 0.1);
    tone(1040, 0.14, 0.1);
    tone(1040, 0.28, 0.1);
  } else if (level === "late") {
    tone(620, 0, 0.18, "sawtooth", 0.08);
    tone(420, 0.2, 0.28, "sawtooth", 0.09);
    tone(620, 0.5, 0.18, "sawtooth", 0.08);
  }
}

function speak(text) {
  if (!state.settings.voice || state.settings.muted || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  window.speechSynthesis.speak(utterance);
}

function voiceFor(level) {
  if (level === "caution") return "Caution";
  if (level === "warn") return "Warning";
  if (level === "late") return "Pull off";
  return "";
}

function checkAlerts(laneId, car, at) {
  if (!car?.windowAt) return false;
  let dirty = false;
  const seconds = departureSeconds(car, at);
  const { cautionAt, warnAt, windowGoal } = state.settings;
  [
    [cautionAt, "caution"],
    [warnAt, "warn"],
    [windowGoal, "late"],
  ].forEach(([mark, key]) => {
    if (seconds >= mark && !car.fired.has(key)) {
      car.fired.add(key);
      dirty = true;
      playAlert(key);
      const phrase = voiceFor(key);
      if (phrase && state.lastVoice[laneId] !== key) {
        speak(laneId === state.activeLane ? phrase : `${state.settings.laneNames[laneId - 1]}. ${phrase}`);
        state.lastVoice[laneId] = key;
      }
      if (key === "late") {
        state.lastLateBeep[laneId] = at;
        haptic([120, 60, 180]);
      }
    }
  });
  if (seconds >= windowGoal && at - state.lastLateBeep[laneId] >= 2000) {
    playAlert("late");
    state.lastLateBeep[laneId] = at;
  }
  return dirty;
}

function sendToWindow(lane, car) {
  car.windowAt = now();
  lane.windowCar = car;
}

function startCar(lane = activeLane()) {
  const car = lane.queue.length ? lane.queue.shift() : createCar();
  sendToWindow(lane, car);
}

function pullOff() {
  ensureAudio();
  haptic(24);
  const lane = activeLane();
  const car = lane.windowCar;
  if (!car) {
    startCar(lane);
    render(true);
    return;
  }
  const departedAt = now();
  if (departedAt - car.windowAt < 600) return;
  state.history.unshift({
    id: car.id,
    number: car.number,
    lane: car.lane,
    sosMs: departedAt - car.arrivedAt,
    depMs: car.windowAt ? departedAt - car.windowAt : 0,
    arrivedAt: car.arrivedAt,
    windowAt: car.windowAt,
    departedAt,
  });
  state.history = state.history.slice(0, 200);
  state.lastVoice[state.activeLane] = "";
  startCar(lane);
  render(true);
}

function undoPullOff() {
  const last = state.history[0];
  if (!last) return;
  haptic(12);
  const lane = state.lanes[last.lane] || activeLane();
  lane.queue = [];
  lane.windowCar = {
    id: last.id,
    number: last.number,
    lane: last.lane,
    arrivedAt: last.arrivedAt,
    windowAt: last.windowAt,
    departedAt: null,
    fired: new Set(),
  };
  state.history.shift();
  state.activeLane = last.lane;
  state.lastVoice[last.lane] = "";
  render(true);
}

function resetShift() {
  if (state.history.length || state.lanes[1].queue.length || state.lanes[2].queue.length || state.lanes[1].windowCar || state.lanes[2].windowCar) {
    if (!window.confirm("Start a new shift and clear all cars and times?")) return;
  }
  state.nextNumber = 1;
  state.lanes = { 1: emptyLane(), 2: emptyLane() };
  state.history = [];
  state.startedAt = now();
  state.lastLateBeep = { 1: 0, 2: 0 };
  state.lastVoice = { 1: "", 2: "" };
  localStorage.removeItem(STORAGE_KEY);
  closeSheet(els.menuSheet);
  render(false);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function setLane(id) {
  state.activeLane = id;
  render(true);
}

function openSheet(el) {
  el.hidden = false;
}

function closeSheet(el) {
  el.hidden = true;
}

function fillSettings() {
  const s = state.settings;
  els.setGoal.value = s.windowGoal;
  els.setCaution.value = s.cautionAt;
  els.setWarn.value = s.warnAt;
  els.setLane1.value = s.laneNames[0];
  els.setLane2.value = s.laneNames[1];
  els.setClock12.checked = s.clock12;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function saveSettings() {
  const goal = clamp(Number(els.setGoal.value) || 30, 15, 90);
  const caution = clamp(Number(els.setCaution.value) || 25, 5, goal - 2);
  const warn = clamp(Number(els.setWarn.value) || 27, caution + 1, goal - 1);
  state.settings.windowGoal = goal;
  state.settings.cautionAt = caution;
  state.settings.warnAt = warn;
  state.settings.laneNames = [
    (els.setLane1.value || "Lane 1").trim().slice(0, 16),
    (els.setLane2.value || "Lane 2").trim().slice(0, 16),
  ];
  state.settings.clock12 = els.setClock12.checked;
  closeSheet(els.settingsSheet);
  render(true);
}

function renderClock() {
  els.clock.textContent = formatClock(new Date(), state.settings.clock12);
  const elapsed = now() - state.startedAt;
  const hours = Math.floor(elapsed / HOUR_MS);
  const minutes = Math.floor((elapsed % HOUR_MS) / 60000);
  els.shiftLabel.textContent = hours ? `Shift ${hours}h ${minutes}m` : `Shift ${minutes}m`;
}

function renderLaneTabs(at) {
  [1, 2].forEach((id) => {
    const lane = state.lanes[id];
    const tab = id === 1 ? els.lane1Btn : els.lane2Btn;
    const timeEl = id === 1 ? els.lane1Time : els.lane2Time;
    tab.classList.toggle("active", state.activeLane === id);
    tab.setAttribute("aria-selected", String(state.activeLane === id));
    tab.querySelector(".lane-tab-name").textContent = state.settings.laneNames[id - 1];
    if (lane.windowCar) {
      const seconds = departureSeconds(lane.windowCar, at);
      timeEl.textContent = formatDuration(seconds * 1000);
      tab.classList.toggle("hot", alertLevel(seconds) === "late");
    } else {
      timeEl.textContent = "—";
      tab.classList.remove("hot");
    }
  });
}

function renderActive(at = now()) {
  const { cautionAt, warnAt, windowGoal } = state.settings;
  els.tickCaution.style.left = `${(cautionAt / windowGoal) * 100}%`;
  els.tickWarn.style.left = `${(warnAt / windowGoal) * 100}%`;
  const lane = activeLane();
  const car = lane.windowCar;
  els.app.dataset.state = car ? "running" : "idle";

  if (car) {
    const depSec = departureSeconds(car, at);
    const level = alertLevel(depSec);
    els.carChip.textContent = `Car #${car.number}`;
    els.carChip.classList.remove("empty");
    els.sosTime.textContent = formatDuration(at - car.arrivedAt);
    els.depTime.textContent = formatDuration(at - car.windowAt);
    els.app.dataset.alert = level;
    els.depMeter.style.width = `${Math.min(100, (depSec / windowGoal) * 100)}%`;
    els.depMeter.style.background =
      level === "late" ? "var(--late)" : level === "warn" ? "var(--warn)" : level === "caution" ? "var(--caution)" : "var(--ok)";
    els.sosHint.textContent = "Tap Pull off each time a car leaves.";
    if (level === "ok") els.depStatus.textContent = "On time";
    if (level === "caution") els.depStatus.textContent = `${cautionAt}s — wrap it up`;
    if (level === "warn") els.depStatus.textContent = `${warnAt}s — they should be leaving`;
    if (level === "late") els.depStatus.textContent = `${windowGoal}s — pull off now`;
  } else {
    els.carChip.textContent = "Tap Pull off to start the lane";
    els.carChip.classList.add("empty");
    els.sosTime.textContent = "0:00";
    els.sosHint.textContent = "Tap Pull off each time a car leaves.";
    els.depTime.textContent = "0:00";
    els.depStatus.textContent = "Ready";
    els.app.dataset.alert = "ok";
    els.depMeter.style.width = "0%";
    els.depMeter.style.background = "var(--ok)";
  }
}

function renderHistory() {
  if (!state.history.length) {
    els.historyList.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "sheet-copy";
    empty.textContent = "Pull-offs will show up here.";
    els.historyList.append(empty);
    return;
  }
  els.historyList.replaceChildren(
    ...state.history.slice(0, 12).map((car) => {
      const card = document.createElement("article");
      card.className = `history-card${car.depMs >= state.settings.windowGoal * 1000 ? " late" : ""}`;
      const left = document.createElement("strong");
      left.textContent = `#${car.number} · ${state.settings.laneNames[car.lane - 1] || `Lane ${car.lane}`}`;
      const right = document.createElement("span");
      right.textContent = formatDuration(car.depMs);
      card.append(left, right);
      return card;
    })
  );
}

function renderStats(at = now()) {
  const cars = state.history;
  const late = cars.filter((car) => car.depMs >= state.settings.windowGoal * 1000);
  const okPct = cars.length ? Math.round(((cars.length - late.length) / cars.length) * 100) : null;
  els.statCars.textContent = String(cars.length);
  els.statDep.textContent = formatDuration(average(cars.map((car) => car.depMs)));
  els.statOk.textContent = okPct == null ? "—" : `${okPct}%`;

  if (!cars.length) {
    els.paceChip.textContent = "Waiting";
    els.paceChip.className = "pace-chip ok";
  } else if (okPct >= 85) {
    els.paceChip.textContent = "On pace";
    els.paceChip.className = "pace-chip ok";
  } else if (okPct >= 70) {
    els.paceChip.textContent = "Watch window";
    els.paceChip.className = "pace-chip watch";
  } else {
    els.paceChip.textContent = "Behind";
    els.paceChip.className = "pace-chip late";
  }

  const buckets = Array.from({ length: 8 }, (_, i) => {
    const start = at - (8 - i) * HOUR_MS;
    return cars.filter((car) => car.departedAt >= start && car.departedAt < start + HOUR_MS).length;
  });
  const max = Math.max(1, ...buckets);
  els.hourly.replaceChildren(
    ...buckets.map((count, index) => {
      const bar = document.createElement("span");
      bar.style.height = `${Math.max(8, (count / max) * 100)}%`;
      if (index === buckets.length - 1) bar.className = "now";
      return bar;
    })
  );
}

function renderButtons() {
  const running = Boolean(activeLane().windowCar);
  els.primaryLabel.textContent = "Pull off";
  els.primaryHint.textContent = running ? "Car left the window" : "Tap to start, then tap each pull-off";
  els.undoBtn.disabled = state.history.length === 0;
  els.muteBtn.textContent = state.settings.muted ? "Sound off" : "Sound on";
  els.voiceBtn.textContent = state.settings.voice ? "Voice on" : "Voice off";
}

function render(persist = false) {
  const at = now();
  const dirty =
    checkAlerts(1, state.lanes[1].windowCar, at) ||
    checkAlerts(2, state.lanes[2].windowCar, at);
  renderClock();
  renderLaneTabs(at);
  renderActive(at);
  renderHistory();
  renderStats(at);
  renderButtons();
  if (persist || dirty) saveShift();
}

function exportCsv() {
  if (!state.history.length) return;
  const rows = [
    ["car", "lane", "arrived", "window", "departed", "sos_s", "window_s"],
    ...[...state.history].reverse().map((car) => [
      car.number,
      car.lane,
      new Date(car.arrivedAt).toISOString(),
      car.windowAt ? new Date(car.windowAt).toISOString() : "",
      new Date(car.departedAt).toISOString(),
      Math.round(car.sosMs / 1000),
      Math.round(car.depMs / 1000),
    ]),
  ];
  const csv = rows.map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `drive-thru-shift-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

els.primaryBtn.addEventListener("click", pullOff);
els.undoBtn.addEventListener("click", undoPullOff);
els.resetBtn.addEventListener("click", resetShift);
els.exportBtn.addEventListener("click", exportCsv);
els.lane1Btn.addEventListener("click", () => setLane(1));
els.lane2Btn.addEventListener("click", () => setLane(2));
els.muteBtn.addEventListener("click", () => {
  state.settings.muted = !state.settings.muted;
  ensureAudio();
  render(true);
});
els.voiceBtn.addEventListener("click", () => {
  state.settings.voice = !state.settings.voice;
  render(true);
});
els.menuBtn.addEventListener("click", () => openSheet(els.menuSheet));
els.menuDone.addEventListener("click", () => closeSheet(els.menuSheet));
els.settingsBtn.addEventListener("click", () => {
  fillSettings();
  openSheet(els.settingsSheet);
});
els.settingsDone.addEventListener("click", saveSettings);
els.menuSheet.addEventListener("click", (event) => {
  if (event.target === els.menuSheet) closeSheet(els.menuSheet);
});
els.settingsSheet.addEventListener("click", (event) => {
  if (event.target === els.settingsSheet) closeSheet(els.settingsSheet);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepAwake();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

loadShift();
keepAwake();
setInterval(render, 100);
render();
