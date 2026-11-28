// Haptic buzz + sound on lock-in. Android uses the Vibration API; iOS Safari (no Vibration API)
// gets a haptic tick from toggling a native switch control.

let audio: AudioContext | null = null;
let iosSwitch: HTMLLabelElement | null = null;

function ctx(): AudioContext | null {
  try {
    audio ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audio.state === 'suspended') void audio.resume();
    return audio;
  } catch {
    return null;
  }
}

/** Must be called from a user gesture once, so iOS allows audio later. */
export function unlockAudio() {
  const a = ctx();
  if (!a) return;
  const b = a.createBuffer(1, 1, 22050);
  const s = a.createBufferSource();
  s.buffer = b;
  s.connect(a.destination);
  s.start(0);
}

function tone(freq: number, start: number, dur: number, gain = 0.18, type: OscillatorType = 'sine') {
  const a = ctx();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t = a.currentTime + start;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export function playLock() {
  tone(1320, 0, 0.09, 0.16, 'triangle');
}

export function playHit() {
  tone(988, 0, 0.12, 0.16, 'triangle');
  tone(1319, 0.08, 0.12, 0.16, 'triangle');
  tone(1976, 0.16, 0.22, 0.14, 'triangle');
}

export function playUndo() {
  tone(520, 0, 0.08, 0.12, 'sine');
}

function iosHaptic() {
  if (!iosSwitch) {
    iosSwitch = document.createElement('label');
    iosSwitch.setAttribute('aria-hidden', 'true');
    iosSwitch.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    iosSwitch.appendChild(input);
    document.body.appendChild(iosSwitch);
  }
  iosSwitch.click();
}

export function buzz(pattern: number | number[] = 30) {
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(pattern);
    return;
  }
  iosHaptic();
}
