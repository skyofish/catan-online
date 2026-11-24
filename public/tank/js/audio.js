// 简短合成音效，无需下载音频或背景音乐。
export function createAudio(button) {
  let ctx;
  let muted = false;
  try { muted = localStorage.getItem('tank.muted') === '1'; } catch {}

  function unlock() {
    if (muted) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    ctx ??= new Audio();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function sync() {
    const text = muted ? '开启音效' : '关闭音效';
    button.setAttribute('aria-pressed', String(muted));
    button.setAttribute('aria-label', text);
    button.title = text;
  }

  button.addEventListener('click', () => {
    muted = !muted;
    try { localStorage.setItem('tank.muted', muted ? '1' : '0'); } catch {}
    sync();
    unlock();
  });
  sync();

  function tone(type, start, end, duration, volume) {
    const time = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(start, time);
    oscillator.frequency.exponentialRampToValueAtTime(end, time + duration);
    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(.001, time + duration);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(time);
    oscillator.stop(time + duration);
  }

  function play(events) {
    if (muted || ctx?.state !== 'running' || document.hidden) return;
    const types = new Set(events.map(({ type }) => type));
    if (types.has('fire')) tone('triangle', 195, 49, .1, .035);
    if (types.has('enemyFire')) tone('sine', 110, 45, .13, .021);
    if (types.has('spark')) tone('triangle', 250, 132, .08, .024);
    if (types.has('blast') || types.has('coreHit')) tone('sawtooth', 92, 29, .28, .034);
    if (types.has('wave')) tone('sine', 280, 560, .3, .052);
  }
  return { unlock, play };
}
