// 用 WebAudio 合成北長尾山雀的叫聲，不需要任何音頻檔案。
// play(name) 回傳 { dur, beats }，beats 是每個音節的 [開始, 結束]（秒），供動畫同步張嘴。
const Sound = (() => {
  let ctx = null;
  let master = null;
  let muted = false;
  let audible = false;
  let base = 0;

  const R = (a, b) => a + Math.random() * (b - a);

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  // 一個音：頻率從 f0 滑到 f1，可選顫音（vib 深度 Hz / vibRate 速率 Hz）
  function tone(t, f0, f1, dur, o = {}) {
    if (!audible) return;
    const t0 = base + t;
    const gain = o.gain ?? 0.25;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(50, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.012, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (o.vib) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = o.vibRate || 35;
      lg.gain.value = o.vib;
      lfo.connect(lg);
      lg.connect(osc.frequency);
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.03);
    }
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  // 沙沙的連續短脈衝（模擬 rattle / trill 的快速振幅調變）
  function rattle(t, f0, f1, dur, rate, gain) {
    const n = Math.max(1, Math.floor(dur * rate));
    for (let k = 0; k < n; k++) {
      const f = f0 + (f1 - f0) * (k / n);
      tone(t + k / rate, f, f * 0.9, 0.032, { gain });
    }
  }

  const PATTERNS = {
    // 細細的、重複的「ツィー ツィー ツィー」（tsee-tsee-tsee）
    tsii() {
      const n = 3 + ((Math.random() * 3) | 0);
      const f = R(7000, 7900);
      const beats = [];
      let t = 0;
      for (let i = 0; i < n; i++) {
        const d = 0.12;
        tone(t, f * 0.98, f * R(1.02, 1.06), d, { gain: 0.2 });
        beats.push([t, t + d]);
        t += 0.19;
      }
      return { dur: t, beats };
    },
    // 沙沙的聯絡聲「ツリュリュ / tsrrr」
    contact() {
      rattle(0, 5800, 6300, 0.34, 38, 0.11);
      return { dur: 0.36, beats: [[0, 0.34]] };
    },
    // 「ジュリリ」：上揚的沙啞顫音，後面接兩聲細鳴
    trill() {
      rattle(0, 4600, 5900, 0.42, 34, 0.13);
      tone(0.55, 7400, 7700, 0.1, { gain: 0.2 });
      tone(0.74, 7500, 7800, 0.1, { gain: 0.2 });
      return { dur: 0.86, beats: [[0, 0.42], [0.55, 0.65], [0.74, 0.84]] };
    },
    // 被摸時舒服的低顫音
    purr() {
      rattle(0, 2900, 3300, 0.55, 26, 0.1);
      return { dur: 0.55, beats: [[0, 0.55]] };
    },
    // 被嚇到：尖銳的「チッ！」
    surprise() {
      tone(0, 8400, 5200, 0.08, { gain: 0.3 });
      tone(0.11, 8000, 5400, 0.09, { gain: 0.26 });
      return { dur: 0.2, beats: [[0, 0.08], [0.11, 0.2]] };
    },
    // 吃完後開心的上揚小調
    happy() {
      const fs = [5200, 6200, 7200];
      const beats = [];
      fs.forEach((f, i) => {
        tone(i * 0.11, f, f * 1.08, 0.09, { gain: 0.22 });
        beats.push([i * 0.11, i * 0.11 + 0.09]);
      });
      tone(0.4, 4400, 5600, 0.3, { gain: 0.16, vib: 600, vibRate: 34 });
      beats.push([0.4, 0.7]);
      return { dur: 0.72, beats };
    },
    // 啄食的小「嗒」聲
    peck() {
      tone(0, 1100, 320, 0.04, { gain: 0.2, type: 'triangle' });
      return { dur: 0.04, beats: [] };
    },
  };

  function play(name) {
    audible = !muted;
    if (audible) {
      ensure();
      base = ctx.currentTime + 0.02;
    }
    return PATTERNS[name]();
  }

  return { play, setMuted: (m) => { muted = !!m; } };
})();
