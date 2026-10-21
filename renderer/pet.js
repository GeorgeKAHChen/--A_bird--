// 行為邏輯：狀態機（發呆 / 跳 / 飛 / 啄食 / 鳴叫 / 睡覺 / 被抓起 / 被摸）、食物、粒子、滑鼠互動。
(() => {
  'use strict';

  // 兩層畫布（省資源）：
  //   #bird  小畫布，只畫鳥和粒子，用 CSS transform 跟著鳥走；
  //   #world 全螢幕畫布，只在有樹枝 / 食物時才配置，內容沒變就不重畫，用不到時縮成 1x1。
  const bcanvas = document.getElementById('bird');
  const ctx = bcanvas.getContext('2d');
  const wcanvas = document.getElementById('world');
  const wctx = wcanvas.getContext('2d');
  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const sgn = (v) => (v < 0 ? -1 : 1);
  const easeIO = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);

  // ---------- 畫布 / 設定 ----------
  let W = 0, H = 0, ground = 0;
  const SIZES = { small: 0.9, medium: 1.3, large: 1.9 };
  let S = SIZES.medium;

  let dpr = 1;
  let boxSize = 0;      // 鳥畫布的邊長（CSS px）

  function layoutBird() {
    boxSize = Math.ceil(210 * S);
    bcanvas.width = Math.round(boxSize * dpr);
    bcanvas.height = Math.round(boxSize * dpr);
    bcanvas.style.width = `${boxSize}px`;
    bcanvas.style.height = `${boxSize}px`;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    ground = H - 2;
    layoutBird();
    worldOn = false;   // 螢幕尺寸變了：世界畫布下次需要時重新配置
    worldSig = '';
  }
  let worldOn = false;
  let worldSig = '';
  resize();
  window.addEventListener('resize', () => {
    const wasOnGround = bird.y >= ground - 1;
    resize();
    bird.x = clamp(bird.x, 30, W - 30);
    if (wasOnGround) bird.y = ground;
  });

  function applySettings(s) {
    S = SIZES[s.size] || SIZES.medium;
    layoutBird();
    Sound.setMuted(s.muted);
  }
  window.api.getSettings().then(applySettings);

  // ---------- 狀態 ----------
  const bird = {
    x: rand(W * 0.2, W * 0.8), y: -120, face: 1,
    wo: 0, ph: 0, yaw: 0, wingFlick: 0, flickIn: 2, glanceIn: 1, glanceTo: 0, glance: 0, perchStay: 12,                 // 翅膀（平滑後的張開度 / 拍動相位）
    petTimer: 0, tailKick: 0, perchSince: 0, lastInteract: 0,
    mode: 'active',                       // active 活躍 / sleeping 角落睡覺 / session 睡醒活動一下 / focus 專注模式
    sleepAfter: rand(60, 120), nextWake: 0, sessionEnd: 0,
    blinkIn: rand(2, 5), blink: 0,
  };
  let act = null;
  let time = 0;
  const mouse = { x: -9999, y: -9999, moved: -99 };
  let strokeAcc = 0;
  let down = null;       // { x, y, t } 按下時的位置
  let dragging = false;
  let lastClick = -99;
  let ignoring = true;
  const foods = [];
  const parts = [];
  const twigs = [];   // 棲木：鳥落在半空時畫一根小樹枝，離開後淡出

  // 鳥離開舊棲木；若有新的落點（半空）就長出一根新的
  function markTwigs(t) {
    for (const w of twigs) w.want = 0;
    if (t) twigs.push({ x: t.x, y: t.y, a: 0, want: 1 });
  }

  function drawTwig(c, w) {
    c.save();
    c.globalAlpha = w.a;
    c.translate(w.x, w.y + 2.5 * S);
    c.scale(S, S);
    c.lineCap = 'round';
    c.strokeStyle = '#6b5240';
    c.lineWidth = 4.5;
    c.beginPath();
    c.moveTo(-64, 3);
    c.quadraticCurveTo(-10, -3, 64, 1);
    c.stroke();
    c.lineWidth = 2.4;
    c.beginPath();
    c.moveTo(32, -0.5); c.lineTo(50, -13);
    c.moveTo(-36, 1); c.lineTo(-54, -9);
    c.stroke();
    c.fillStyle = '#8a6a52';
    for (const [x, y] of [[50, -13], [-54, -9], [64, 1], [-64, 3]]) {
      c.beginPath();
      c.arc(x, y, 2.4, 0, TAU);
      c.fill();
    }
    c.strokeStyle = 'rgba(255,255,255,0.95)';
    c.lineWidth = 2.2;
    c.beginPath();
    c.moveTo(-52, 0.4);
    c.quadraticCurveTo(-10, -5.6, 52, -1.6);
    c.stroke();
    c.restore();
  }

  function startAct(name, o) {
    act = Object.assign({ name, t: 0 }, o);
    if (ACT[name].init) ACT[name].init(act);
  }

  const onGround = () => bird.y >= ground - 2;

  // 使用者和鳥互動了：重新計算「多久沒人理就去睡覺」；睡著 / 活動中的鳥回到活躍狀態
  function touch() {
    bird.lastInteract = time;
    bird.sleepAfter = rand(60, 120);
    if (bird.mode === 'sleeping' || bird.mode === 'session') bird.mode = 'active';
  }

  // 站在樹枝上時，跳躍只能在樹枝範圍內，不會跳到枝外面懸在半空
  function perchRange() {
    if (onGround()) return [30, W - 30];
    const w = twigs.find((t) => t.want && Math.abs(t.y - bird.y) < 20 * S && Math.abs(t.x - bird.x) < 70 * S);
    if (!w) return [30, W - 30];
    return [Math.max(30, w.x - 48 * S), Math.min(W - 30, w.x + 48 * S)];
  }

  // 換方向時先轉回正面再轉向，避免鏡像翻轉太突兀
  function setFace(f) {
    if (f !== bird.face) { bird.face = f; bird.yaw = 0; }
  }

  // ---------- 粒子 ----------
  function spawnHeart(x, y) {
    parts.push({ k: 'heart', x, y, vx: rand(-8, 8), vy: rand(-48, -32), life: 0, max: 1.5, s: rand(5, 8) * S / 1.3 });
  }
  function spawnNote(x, y) {
    parts.push({ k: 'note', x, y, vx: rand(8, 22), vy: rand(-42, -28), life: 0, max: 1.4, s: S / 1.3 });
  }
  function spawnZ(x, y) {
    parts.push({ k: 'z', x, y, vx: rand(6, 12), vy: -16, life: 0, max: 2.6, s: S / 1.3 });
  }
  function spawnCrumb(x, y, color) {
    parts.push({ k: 'crumb', x, y, vx: rand(-70, 70), vy: rand(-170, -80), life: 0, max: 0.8, s: rand(1.5, 2.6) * S / 1.3, color });
  }
  function spawnFeather(x, y) {
    parts.push({ k: 'feather', x, y, vx: rand(-25, 25), vy: rand(-20, 0), life: 0, max: 2.2, s: S / 1.3, r: rand(0, TAU) });
  }

  function updateParts(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i];
      q.life += dt;
      if (q.life >= q.max) { parts.splice(i, 1); continue; }
      if (q.k === 'crumb') {
        q.vy += 900 * dt;
        if (q.y > ground) { parts.splice(i, 1); continue; }
      } else if (q.k === 'feather') {
        q.vy = lerp(q.vy, 28, 1 - Math.exp(-2 * dt));
        q.vx = Math.sin(q.life * 4 + q.r) * 24;
        q.r += dt * 3;
      } else {
        q.vx += Math.sin(q.life * 5 + q.x) * 20 * dt;
      }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
  }

  function drawHeart(c, x, y, s) {
    c.beginPath();
    c.moveTo(x, y + s * 0.9);
    c.bezierCurveTo(x - s * 1.7, y - s * 0.1, x - s * 0.9, y - s * 1.3, x, y - s * 0.4);
    c.bezierCurveTo(x + s * 0.9, y - s * 1.3, x + s * 1.7, y - s * 0.1, x, y + s * 0.9);
    c.fill();
  }

  function drawParts(c) {
    for (const q of parts) {
      const u = q.life / q.max;
      const a = u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85;
      c.globalAlpha = clamp(a, 0, 1);
      if (q.k === 'heart') {
        c.fillStyle = '#ff7f95';
        drawHeart(c, q.x, q.y, q.s);
      } else if (q.k === 'note') {
        c.save();
        c.translate(q.x, q.y);
        c.scale(q.s, q.s);
        c.fillStyle = c.strokeStyle = '#6a77a8';
        c.lineWidth = 1.6;
        c.beginPath();
        c.ellipse(0, 0, 3.6, 2.6, -0.4, 0, TAU);
        c.fill();
        c.beginPath();
        c.moveTo(3.2, -1);
        c.lineTo(3.2, -12);
        c.quadraticCurveTo(7, -10, 7.5, -6);
        c.stroke();
        c.restore();
      } else if (q.k === 'z') {
        c.fillStyle = '#7f86b4';
        c.font = `italic bold ${Math.round(12 + u * 10) * q.s}px sans-serif`;
        c.fillText('Z', q.x, q.y);
      } else if (q.k === 'crumb') {
        c.fillStyle = q.color;
        c.fillRect(q.x, q.y, q.s, q.s);
      } else if (q.k === 'feather') {
        c.save();
        c.translate(q.x, q.y);
        c.rotate(q.r);
        c.scale(q.s, q.s);
        c.fillStyle = '#fffdfa';
        c.strokeStyle = 'rgba(78,64,72,0.45)';
        c.lineWidth = 0.8;
        c.beginPath();
        c.ellipse(0, 0, 4.5, 1.7, 0, 0, TAU);
        c.fill();
        c.stroke();
        c.restore();
      }
    }
    c.globalAlpha = 1;
  }

  // ---------- 食物 ----------
  const FOOD_KINDS = {
    seed: { bites: 2, crumb: '#4a4a4a' },
    berry: { bites: 3, crumb: '#e0505a' },
    worm: { bites: 3, crumb: '#d9b27a' },
  };

  function feed() {
    const kinds = Object.keys(FOOD_KINDS);
    const n = 1 + ((Math.random() * 2) | 0);
    for (let i = 0; i < n && foods.length < 5; i++) {
      const kind = kinds[(Math.random() * kinds.length) | 0];
      foods.push({
        kind, x: clamp(bird.x + rand(-320, 320), 50, W - 50), y: -20 - i * 70, vy: 0,
        rot: rand(0, TAU), landed: false, bites: FOOD_KINDS[kind].bites, max: FOOD_KINDS[kind].bites,
      });
    }
    touch();
  }

  function updateFoods(dt) {
    for (const f of foods) {
      if (f.landed) continue;
      f.vy += 1400 * dt;
      f.y += f.vy * dt;
      f.rot += dt * 4;
      if (f.y >= ground - 4 * S) {
        f.y = ground - 4 * S;
        f.landed = true;
        f.rot = rand(-0.4, 0.4);
      }
    }
  }

  function drawFood(c, f) {
    const k = 0.45 + 0.55 * (f.bites / f.max);
    const s = S * k;
    c.save();
    c.translate(f.x, f.y);
    c.rotate(f.rot);
    c.scale(s, s);
    c.lineWidth = 1;
    if (f.kind === 'seed') {
      c.fillStyle = '#34312f';
      c.beginPath();
      c.moveTo(-6, 0);
      c.quadraticCurveTo(0, -5.5, 7, 0);
      c.quadraticCurveTo(0, 5.5, -6, 0);
      c.fill();
      c.strokeStyle = '#d9d4cc';
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(-4, 0);
      c.lineTo(4.5, 0);
      c.stroke();
    } else if (f.kind === 'berry') {
      c.fillStyle = '#d94652';
      c.beginPath();
      c.arc(0, 0, 5.5, 0, TAU);
      c.fill();
      c.fillStyle = 'rgba(255,255,255,0.7)';
      c.beginPath();
      c.arc(-1.8, -1.8, 1.5, 0, TAU);
      c.fill();
      c.fillStyle = '#4f9a4a';
      c.beginPath();
      c.ellipse(1.5, -5.5, 3.2, 1.6, -0.5, 0, TAU);
      c.fill();
    } else {
      const wig = f.landed ? Math.sin(time * 6 + f.x) * 1.4 : 0;
      for (let i = 0; i < 5; i++) {
        c.fillStyle = i % 2 ? '#d4a96a' : '#e3c08a';
        c.beginPath();
        c.arc(-7 + i * 3.6, Math.sin(i * 1.2 + time * 6) * wig * 0.5, 2.5, 0, TAU);
        c.fill();
      }
    }
    c.restore();
  }

  const nearestLanded = () => {
    let best = null;
    let bd = Infinity;
    for (const f of foods) {
      if (!f.landed) continue;
      const d = Math.abs(f.x - bird.x);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  };

  function bite(f) {
    f.bites--;
    const col = FOOD_KINDS[f.kind].crumb;
    for (let i = 0; i < 4; i++) spawnCrumb(f.x, f.y, col);
    if (f.bites <= 0) {
      foods.splice(foods.indexOf(f), 1);
      return true;
    }
    return false;
  }

  // ---------- 行為 ----------
  const ACT = {
    idle: {
      soft: true,
      init(a) {
        a.dur = a.dur ?? rand(6, 14);
        a.turnCheck = rand(0.5, 1.2);
        a.yaw = Math.random() < 0.55 ? 0 : 0.85;
      },
      tick(a, dt, p) {
        a.turnCheck -= dt;
        if (a.turnCheck <= 0) {
          a.turnCheck = rand(0.6, 1.4);
          const behind = (mouse.x - bird.x) * bird.face < -80;
          if (behind && time - mouse.moved < 4 && Math.abs(mouse.x - bird.x) < 500 && Math.random() < 0.5) {
            setFace(-bird.face);
            bird.tailKick = 0.4;
          }
        }
        p.yaw = a.yaw;
        return a.t >= a.dur;
      },
    },

    hop: {
      init(a) {
        a.x0 = bird.x;
        a.y0 = bird.y;
        const [lo, hi] = perchRange();
        let dir = a.dir ?? (Math.random() < 0.5 ? -1 : 1);
        let dx = a.dx ?? dir * rand(25, 70) * S;
        a.x1 = clamp(a.x0 + dx, lo, hi);
        if (a.dx === undefined && Math.abs(a.x1 - a.x0) < 8 * S) {   // 靠近樹枝盡頭：反方向跳
          dx = -dir * rand(25, 55) * S;
          a.x1 = clamp(a.x0 + dx, lo, hi);
          if (Math.abs(a.x1 - a.x0) < 8 * S) a.x1 = a.x0;
        }
        if (Math.abs(a.x1 - a.x0) > 4) setFace(sgn(a.x1 - a.x0));
        a.dur = 0.2 + Math.abs(a.x1 - a.x0) / 600;
        a.h = rand(10, 18) * S;
      },
      tick(a, dt, p) {
        const u = clamp(a.t / a.dur, 0, 1);
        bird.x = lerp(a.x0, a.x1, u);
        bird.y = a.y0 - 4 * u * (1 - u) * a.h;
        const arc = Math.sin(Math.PI * u);
        p.yaw = 0.75;
        p.flapHz = 16;
        p.tilt = -0.12 * arc;
        p.air = arc > 0.25 ? 1 : 0;
        p.wingOpen = 0.35 * arc;
        p.tail = 0.3 * arc;
        if (u < 0.15) p.squash = 1 - 0.1 * (1 - u / 0.15);
        if (u >= 1) { bird.y = a.y0; return true; }
        return false;
      },
    },

    fly: {
      init(a) {
        a.x0 = bird.x;
        a.y0 = bird.y;
        a.x1 = a.free ? a.tx : clamp(a.tx, 30, W - 30);
        a.y1 = a.ty;
        const dx = a.x1 - a.x0;
        const dist = Math.hypot(dx, a.y1 - a.y0);
        a.dur = 0.4 + dist / 640;
        const top = Math.min(a.y0, a.y1);
        a.cx = (a.x0 + a.x1) / 2;
        a.cy = Math.max(top - 35 - dist * 0.16, Math.min(top, 30));
        a.pre = a.pass2 ? 0 : 0.2;
        a.post = a.via ? 0 : 0.3;
        if (Math.abs(dx) > 10) setFace(sgn(dx));
        a.launched = false;
        // 目標在半空：長出一根棲木；目標在地面：舊棲木淡出
        markTwigs(!a.via && a.y1 < ground - 10 ? { x: a.x1, y: a.y1 } : null);
      },
      tick(a, dt, p) {
        const T0 = a.pre;
        const T1 = a.pre + a.dur;
        p.flapHz = 16;
        p.yaw = a.t < T0 ? 0.8 : 1;
        if (a.t < T0) {
          const u = a.t / T0;
          p.squash = 1 - 0.2 * easeIO(u);
          p.wingOpen = 0.4 * u;
          p.tilt = -0.25 * u;
          p.tail = 0.4 * u;
          return false;
        }
        if (!a.launched) {
          a.launched = true;
          spawnFeather(bird.x, bird.y - 30 * S);
          if (Math.random() < 0.5) spawnFeather(bird.x, bird.y - 30 * S);
        }
        if (a.t < T1) {
          const u = (a.t - T0) / a.dur;
          const e = lerp(u, easeIO(u), 0.6);
          const B = (k) => {
            const m = 1 - k;
            return [m * m * a.x0 + 2 * m * k * a.cx + k * k * a.x1, m * m * a.y0 + 2 * m * k * a.cy + k * k * a.y1];
          };
          const [x, y] = B(e);
          const [x2, y2] = B(Math.min(1, e + 0.02));
          // 一陣陣拍翅 + 滑翔的波浪式飛行
          const cyc = ((a.t - T0) * 3.4) % 1;
          const burst = cyc < 0.7;
          bird.x = x;
          bird.y = y - Math.sin(cyc * TAU) * 6.5 * S * Math.sin(Math.PI * u);
          p.air = 1;
          p.wingOpen = burst ? 1 : 0.05;
          p.tail = 0.5;                  // 尾巴向後拉成一條線
          p.puff = 1.03;
          p.tilt = Math.atan2(y2 - y, Math.abs(x2 - x) + 0.001) * 0.8 + Math.sin(a.t * 30) * 0.04;
          return false;
        }
        bird.x = a.x1;
        bird.y = a.y1;
        if (!a.post) return true;
        const lt = (a.t - T1) / a.post;
        p.air = lt < 0.3 ? 1 : 0;
        p.wingOpen = 1 - lt * 0.9;
        p.tail = 0.7 * (1 - lt);
        p.tilt = -0.35 * (1 - lt);
        p.squash = 1 - 0.12 * Math.sin(Math.PI * Math.min(1, lt));
        return lt >= 1;
      },
    },

    peck: {
      init(a) {
        a.n = a.n ?? 3;
        a.dur = a.n * 0.42 + 0.35;
        a.lastK = -1;
      },
      tick(a, dt, p) {
        p.yaw = 0.8;
        const tt = a.t - 0.15;
        if (tt > 0 && tt < a.n * 0.42) {
          const k = Math.floor(tt / 0.42);
          const ph = (tt % 0.42) / 0.42;
          const dip = Math.pow(Math.sin(Math.PI * ph), 1.5);
          p.tilt = 0.55 * dip;
          p.tail = 0.5 * dip;
          p.squash = 0.97;
          if (ph > 0.5 && a.lastK !== k) {
            a.lastK = k;
            Sound.play('peck');
            if (a.food) {
              if (!foods.includes(a.food)) { a.food = null; }
              else if (bite(a.food)) { a.food = null; a.ate = true; }
            } else {
              spawnCrumb(bird.x + bird.face * 30 * S, ground, '#c9b79c');
            }
          }
        }
        if (a.t >= a.dur) {
          if (a.ate) {
            touch();
            startAct('sing', { pattern: 'happy', happy: true });
            return false;
          }
          return true;
        }
        return false;
      },
    },

    sing: {
      soft: true,
      init(a) {
        a.pattern = a.pattern || ['tsii', 'tsii', 'trill', 'contact'][(Math.random() * 4) | 0];
        const r = Sound.play(a.pattern);
        a.beats = r.beats;
        a.dur = r.dur + 0.5;
        a.noteIdx = 0;
      },
      tick(a, dt, p) {
        let open = 0;
        a.beats.forEach(([s, e], i) => {
          if (a.t >= s && a.t <= e) open = 1;
          if (a.t >= s && i >= a.noteIdx) {
            a.noteIdx = i + 1;
            spawnNote(bird.x + bird.face * 26 * S, bird.y - 42 * S);
            bird.tailKick = 0.45;
            bird.wingFlick = 1;
          }
        });
        p.yaw = 0.25;
        p.beak = open;
        p.tilt = -0.28;
        p.puff = 1.06;
        p.tail = 0.25;
        if (a.happy) p.eye = 'happy';
        return a.t >= a.dur;
      },
    },

    // 倒掛：用腳抓著棲木，整隻翻到枝下（山雀覓食的招牌姿勢）
    hang: {
      init(a) { a.dur = rand(2.5, 4.5); },
      tick(a, dt, p) {
        const T = 0.4;
        const w = clamp(Math.min(a.t / T, (a.dur - a.t) / T), 0, 1);
        p.roll = Math.PI * easeIO(w);
        p.yaw = 1;
        p.air = 0;
        p.tilt = 0.18 * Math.sin(a.t * 9) * w;          // 低頭啄枝的小動作
        p.tail = 0.1;
        return a.t >= a.dur;
      },
    },

    shake: {
      soft: true,
      init(a) {
        a.dur = 0.7;
        for (let i = 0; i < 3; i++) spawnFeather(bird.x, bird.y - 30 * S);
      },
      tick(a, dt, p) {
        const k = Math.sin(Math.PI * clamp(a.t / a.dur, 0, 1));
        p.puff = 1 + 0.16 * k;
        p.tilt = 0.07 * Math.sin(a.t * 55) * k;
        p.eye = 'closed';
        return a.t >= a.dur;
      },
    },

    sleep: {
      soft: true,
      init(a) {
        a.dur = a.dur ?? rand(15, 35);
        a.zT = 0.5;
      },
      tick(a, dt, p) {
        p.eye = 'closed';
        p.squash = 0.93;
        p.puff = 1.16 + 0.03 * (Math.floor(time * 0.5) % 2);   // 每 2 秒一次的慢呼吸（省電：兩種狀態切換）
        p.tail = -0.1;
        a.zT -= dt;
        if (a.zT <= 0 && !a.quiet && a.t < 12) {   // Z 只在剛睡著的前幾秒冒，之後安靜地睡（省電）
          a.zT = 2.4;
          spawnZ(bird.x + bird.face * 18 * S, bird.y - 55 * S);
        }
        return a.t >= a.dur;
      },
    },

    held: {
      init(a) { a.vx = 0; a.px = bird.x; },
      tick(a, dt, p) {
        const tx = clamp(mouse.x, 20, W - 20);
        const ty = clamp(mouse.y + 28 * S, 70 * S, ground);
        bird.x = lerp(bird.x, tx, 1 - Math.exp(-30 * dt));
        bird.y = lerp(bird.y, ty, 1 - Math.exp(-30 * dt));
        a.vx = lerp(a.vx, (bird.x - a.px) / Math.max(dt, 0.001), 1 - Math.exp(-8 * dt));
        a.px = bird.x;
        p.air = 1;
        p.eye = 'wide';
        p.wingOpen = 0.65;
        p.beak = 0.3;
        p.tilt = clamp(a.vx * 0.0005, -0.4, 0.4) * bird.face + Math.sin(a.t * 3) * 0.05;
        p.tail = 0.1;
        return false;
      },
    },

    startle: {
      init(a) {
        a.dur = 0.5;
        a.y0 = bird.y;
        a.beats = Sound.play('surprise').beats;
        bird.tailKick = 0.7;
      },
      tick(a, dt, p) {
        const u = clamp(a.t / a.dur, 0, 1);
        bird.y = a.y0 - 4 * u * (1 - u) * 22 * S;
        p.eye = 'wide';
        p.puff = 1.1;
        p.air = u > 0.1 && u < 0.9 ? 1 : 0;
        p.wingOpen = 0.5 * Math.sin(Math.PI * u);
        p.beak = a.beats.some(([s, e]) => a.t >= s && a.t <= e) ? 1 : 0;
        if (u >= 1) { bird.y = a.y0; return true; }
        return false;
      },
    },

    // 被撫摸：瞇眼、鼓毛、腮紅、冒愛心、發出舒服的顫音
    pet: {
      soft: true,
      init(a) {
        a.heartT = 0;
        a.purrT = 0;
        a.beats = [];
        a.purrAt = -9;
      },
      tick(a, dt, p) {
        touch();
        if (bird.petTimer <= 0) {
          if (a.t > 2.5) startAct('sing', { pattern: Math.random() < 0.5 ? 'happy' : 'tsii', happy: true });
          else startAct('idle', { dur: 0.4 });
          return false;
        }
        if (a.t > 9) {
          // 摸太久，舒服到睡著了
          startAct('sleep', { dur: rand(15, 30) });
          return false;
        }
        const melt = clamp(a.t / 6, 0, 1);
        p.eye = a.t > 5 ? 'closed' : 'happy';
        p.cheek = 1;
        p.puff = 1.08 + 0.05 * melt + 0.02 * Math.sin(a.t * 6);
        p.squash = 0.97 - 0.05 * melt;
        p.tilt = 0.1 + 0.08 * clamp((mouse.x - bird.x) * bird.face / 60, -1, 1);
        p.wingOpen = 0.1 + 0.05 * Math.sin(a.t * 9);
        p.tail = 0.1 + 0.12 * Math.sin(a.t * 5);

        a.heartT -= dt;
        if (a.heartT <= 0) {
          a.heartT = rand(0.55, 0.9);
          spawnHeart(bird.x + rand(-14, 14) * S, bird.y - 56 * S);
        }
        a.purrT -= dt;
        if (a.purrT <= 0) {
          a.purrT = 1.1;
          a.purrAt = a.t;
          a.beats = Sound.play('purr').beats;
        }
        const rel = a.t - a.purrAt;
        p.beak = a.beats.some(([s, e]) => rel >= s && rel <= e) ? 0.35 : 0;
        return false;
      },
    },
  };

  // ---------- 決策 ----------
  // 山雀多半是短距離的小飛：80% 在附近飛，偶爾才橫越整個螢幕；一半機率飛上樹枝
  function flyRandom(chain) {
    const far = Math.random() < 0.2;
    let tx = bird.x + (Math.random() < 0.5 ? -1 : 1) * (far ? rand(300, W * 0.8) : rand(120, 420));
    if (tx < 40 || tx > W - 40) tx = clamp(2 * bird.x - tx, 40, W - 40);
    const toTwig = Math.random() < 0.5;
    startFly(tx, toTwig ? ground - rand(130, 300) * (S / 1.3) : ground, chain);
  }

  function startFly(tx, ty, chain) {
    const via = chain && Math.random() < 0.3;
    if (via) {
      // 偶爾先飛到空中再落下，看起來更像在飛
      const mx = rand(W * 0.15, W * 0.85);
      const my = rand(H * 0.35, H * 0.65);
      startAct('fly', { tx: mx, ty: my, via: true, next: { tx, ty } });
    } else {
      startAct('fly', { tx, ty });
    }
  }

  function goToFood(f) {
    const dir = Math.abs(f.x - bird.x) < 1 ? bird.face : sgn(f.x - bird.x);
    const stand = clamp(f.x - dir * 30 * S, 20, W - 20);
    const dxs = stand - bird.x;
    if (!onGround()) {
      setFace(dir);
      startAct('fly', { tx: stand, ty: ground });
    } else if (Math.abs(dxs) < 10 * S) {
      setFace(dir);
      startAct('peck', { n: f.bites, food: f });
    } else if (Math.abs(dxs) > 220 * S) {
      startAct('fly', { tx: stand, ty: ground });
    } else {
      startAct('hop', { dx: clamp(dxs, -55 * S, 55 * S) });
    }
  }

  // ---------- 作息 ----------
  // 活躍 → 1~2 分鐘沒人理就飛到螢幕角落睡覺 → 之後每 10~30 分鐘醒來活動 30~50 秒再回去睡。
  // 專注模式：躲到螢幕右側邊緣（一半身體在螢幕外）的小樹枝上睡覺，不出聲、不干擾。
  function enterCorner() {
    const cx = bird.x < W / 2 ? 40 * S : W - 40 * S;
    const dist = Math.abs(bird.x - cx);
    if (onGround() && dist < 10) {
      setFace(cx < W / 2 ? 1 : -1);
      bird.nextWake = time + rand(600, 1800);
      return startAct('sleep', { dur: Infinity });
    }
    if (onGround() && dist < 140 * S) return startAct('hop', { dx: clamp(cx - bird.x, -60 * S, 60 * S) });
    return startAct('fly', { tx: cx, ty: ground });
  }

  function focusStep() {
    const fx = W - 16 * S;
    const fy = Math.round(H * 0.6);
    if (Math.abs(bird.x - fx) < 6 && Math.abs(bird.y - fy) < 6) {
      setFace(-1);
      return startAct('sleep', { dur: Infinity, quiet: true });
    }
    return startAct('fly', { tx: fx, ty: fy, free: true });
  }

  function setFocus(on) {
    if (on) {
      bird.mode = 'focus';
      foods.length = 0;
      parts.length = 0;
      down = null;
      dragging = false;
      focusStep();
    } else if (bird.mode === 'focus') {
      bird.mode = 'active';
      touch();
      bird.perchSince = time;
      startFly(rand(W * 0.3, W * 0.7), ground, false);
    }
  }

  function startSession() {
    bird.mode = 'session';
    bird.sessionEnd = time + rand(30, 50);
    startAct('shake');
  }

  function chooseNext() {
    if (bird.mode === 'focus') return focusStep();
    if (bird.petTimer > 0) return startAct('pet');
    const f = nearestLanded();
    if (f) return goToFood(f);
    if (bird.mode === 'sleeping') return enterCorner();
    if (bird.mode === 'session' && time > bird.sessionEnd) { bird.mode = 'sleeping'; return enterCorner(); }
    if (bird.mode === 'active' && time - bird.lastInteract > bird.sleepAfter) { bird.mode = 'sleeping'; return enterCorner(); }

    const session = bird.mode === 'session';
    const ground_ = onGround();
    const away = time - bird.perchSince > bird.perchStay;   // 在樹枝上待夠久了
    const opts = session ? [
      ['idle', 20], ['hop', 25], ['fly', ground_ ? 22 : (away ? 70 : 0)], ['hang', ground_ ? 0 : 12],
      ['forage', ground_ ? 12 : 0], ['sing', 14], ['turn', 6], ['shake', 3],
    ] : [
      ['idle', 90], ['hop', 8], ['fly', ground_ ? 4 : (away ? 70 : 0)], ['hang', ground_ ? 0 : 10],
      ['forage', ground_ ? 4 : 0], ['sing', 3], ['turn', 4], ['shake', 1],
    ];
    let r = Math.random() * opts.reduce((sum, o) => sum + o[1], 0);
    let pick = 'idle';
    for (const [name, w] of opts) {
      if ((r -= w) < 0) { pick = name; break; }
    }
    switch (pick) {
      case 'hop': return startAct('hop');
      case 'fly': return flyRandom(true);
      case 'forage': return startAct('peck', { n: 2 + ((Math.random() * 3) | 0) });
      case 'sing': return startAct('sing');
      case 'turn': setFace(-bird.face); bird.tailKick = 0.4; return startAct('idle', { dur: rand(0.8, 2) });
      case 'shake': return startAct('shake');
      case 'hang': return startAct('hang');
      default: return startAct('idle', session ? { dur: rand(1.5, 3.5) } : undefined);
    }
  }

  function onActEnd(a) {
    if (a.name === 'fly') {
      if (a.next) return startAct('fly', Object.assign({ pass2: true }, a.next));
      bird.perchSince = time;
      bird.perchStay = rand(20, 45);
    }
    if (a.name === 'hop' || a.name === 'startle') bird.perchSince = time;
    chooseNext();
  }

  // ---------- 外部指令（托盤 / 右鍵選單） ----------
  window.api.onCommand((cmd, data) => {
    if (cmd === 'settings') return applySettings(data);
    if (cmd === 'focus') return setFocus(!!data);
    if (bird.mode === 'focus' || act.name === 'held') return;
    touch();
    if (cmd === 'feed') feed();
    else if (cmd === 'sing') startAct('sing');
    else if (cmd === 'fly') flyRandom(true);
    else if (cmd === 'sleep') { bird.mode = 'sleeping'; enterCorner(); }
  });

  // ---------- 滑鼠互動 ----------
  function hit(x, y) {
    if (bird.mode === 'focus') return false;   // 專注模式：完全不攔截滑鼠
    const dx = x - bird.x;
    const dy = y - (bird.y - 30 * S);
    return dx * dx + dy * dy < (34 * S) * (34 * S);
  }

  function setIgnore(v) {
    if (v !== ignoring) {
      ignoring = v;
      window.api.setIgnore(v);
    }
  }

  window.addEventListener('mousemove', (e) => {
    const d = Math.hypot(e.clientX - mouse.x, e.clientY - mouse.y);
    const first = mouse.x < -9000;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.moved = time;
    if (first) return;
    if (down && !dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
      dragging = true;
      touch();
      startAct('held');
      Sound.play('surprise');
    }
    if (!dragging && !down && hit(e.clientX, e.clientY)) strokeAcc = Math.min(200, strokeAcc + d);
  });

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hit(e.clientX, e.clientY)) return;
    down = { x: e.clientX, y: e.clientY, t: time };
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !down) return;
    const wasDrag = dragging;
    const d = down;
    down = null;
    dragging = false;
    touch();
    if (wasDrag) {
      if (ground - bird.y < 25 * S) bird.y = ground;
      markTwigs(bird.y < ground - 2 ? { x: bird.x, y: bird.y } : null);
      bird.perchStay = rand(25, 60);
      bird.perchSince = time;
      startAct('startle');
    } else if (time - d.t < 0.5) {
      if (time - lastClick < 0.35) {
        flyRandom(true);   // 雙擊：飛走
        lastClick = -99;
      } else {
        startAct('startle');
        lastClick = time;
      }
    }
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (hit(e.clientX, e.clientY)) window.api.showMenu();
  });

  // ---------- 主迴圈 ----------
  function basePose() {
    return {
      x: 0, y: 0, face: 1, yaw: 0, tilt: 0, squash: 1, puff: 1, air: 0,
      wingOpen: 0, ph: 0, flapHz: 8, roll: 0, tail: 0, eye: 'open', beak: 0, lookX: 0, lookY: 0, cheek: 0,
    };
  }

  function update(dt) {
    time += dt;
    bird.petTimer = Math.max(0, bird.petTimer - dt);
    strokeAcc = Math.max(0, strokeAcc - 80 * dt);
    updateFoods(dt);
    updateParts(dt);
    for (let i = twigs.length - 1; i >= 0; i--) {
      const w = twigs[i];
      w.a += (w.want - w.a) * (1 - Math.exp(-4 * dt));
      if (!w.want && w.a < 0.02) twigs.splice(i, 1);
    }

    // 滑鼠是否在鳥身上（鳥自己移動時也要重新判斷，否則游標會被透明視窗卡住）
    const over = hit(mouse.x, mouse.y);
    bird.hot = over;
    if (!down) setIgnore(!over);

    // 撫摸判定：在鳥身上持續來回移動
    const thr = act.name === 'pet' ? 12 : 30;
    if (over && !dragging && !down && strokeAcc > thr && time - mouse.moved < 0.4) {
      bird.petTimer = 0.45;
      if (act.soft && act.name !== 'pet') startAct('pet');
    }

    // 食物落地時，放下手邊的小事去吃
    if (act.soft && act.name !== 'pet' && nearestLanded()) chooseNext();

    if (bird.mode === 'sleeping' && act.name === 'sleep' && time >= bird.nextWake) startSession();

    const p = basePose();
    const done = ACT[act.name].tick(act, dt, p);
    act.t += dt;
    if (done) onActEnd(act);

    // 尾巴 / 翅膀不時抖一下，視線一頓一頓地快速轉向（山雀動作又快又碎）
    const asleep = act.name === 'sleep';
    bird.flickIn -= dt;
    if (bird.flickIn <= 0 && !asleep) {
      bird.flickIn = rand(3, 8);
      bird.tailKick = 0.5;
      if (Math.random() < 0.4) bird.wingFlick = 1;
    }
    if (asleep) bird.wingFlick = 0;
    bird.wingFlick *= Math.exp(-9 * dt);
    p.wingOpen = Math.max(p.wingOpen, 0.35 * bird.wingFlick);
    bird.glanceIn -= dt;
    if (bird.glanceIn <= 0) {
      bird.glanceIn = rand(0.8, 2.6);
      bird.glanceTo = rand(-1, 1);
    }
    bird.glance = bird.glanceTo;   // 視線一次轉到位（像真的山雀，一頓一頓的；也省畫面更新）

    // 轉身平滑
    bird.yaw = lerp(bird.yaw, p.yaw, 1 - Math.exp(-12 * dt));
    p.yaw = bird.yaw;

    // 站在樹枝上時尾巴斜斜垂下（地面上則收短，避免穿出畫面）
    if (bird.y < ground - 10 && act.name !== 'fly' && act.name !== 'held') p.tail -= 0.4;

    // 翅膀平滑 + 拍動相位
    bird.wo = lerp(bird.wo, p.wingOpen, 1 - Math.exp(-25 * dt));
    bird.ph += dt * TAU * p.flapHz;
    p.roll = p.roll || 0;
    p.wingOpen = bird.wo;
    p.ph = bird.ph;

    // 呼吸、眨眼、尾巴輕搖
    if (!asleep) p.puff *= 1 + 0.015 * Math.sin(time * 2.2);
    bird.blinkIn -= dt;
    if (bird.blinkIn <= 0) { bird.blink = 0.12; bird.blinkIn = rand(2, 6); }
    if (asleep) bird.blink = 0;
    if (bird.blink > 0) {
      bird.blink -= dt;
      if (p.eye === 'open') p.eye = 'blink';
    }
    bird.tailKick *= Math.exp(-5 * dt);
    if (asleep) bird.tailKick = 0;
    p.tail += bird.tailKick * Math.cos(time * 28) + 0;

    // 視線：跟著掉落的食物或游標
    const falling = foods.find((f) => !f.landed);
    const target = falling ? { x: falling.x, y: falling.y } : (time - mouse.moved < 5 ? mouse : null);
    if (target && p.eye !== 'closed' && p.eye !== 'happy' && act.name !== 'held') {
      const lx = clamp(((target.x - bird.x) * bird.face) / 70, -1, 1);
      const ly = clamp((target.y - (bird.y - 30 * S)) / 90, -1, 1);
      p.lookX += lx * 2.4;
      p.lookY += ly * 2.2;
      if (falling) p.lookY -= 1.5;
    }

    if (p.eye === 'open' || p.eye === 'wide' || p.eye === 'blink') p.lookX += bird.glance * (target ? 0.8 : 2.6);
    p.x = bird.x;
    p.y = bird.y;
    p.face = bird.face;
    return p;
  }

  function renderWorld() {
    const need = twigs.length > 0 || foods.length > 0;
    let sig = '';
    if (need) {
      sig = twigs.map((w) => `${Math.round(w.x)},${Math.round(w.y)},${Math.round(w.a * 60)}`).join(';') + '|'
        + foods.map((f) => `${Math.round(f.x)},${Math.round(f.y)},${f.bites},${f.landed ? 0 : Math.round(f.rot * 10)}`).join(';')
        + (foods.some((f) => f.kind === 'worm' && f.landed) ? `|${Math.floor(time * 8)}` : '');
    }
    if (sig === worldSig) return;
    if (!need) {
      if (worldOn) {
        wcanvas.width = 1;
        wcanvas.height = 1;
        wcanvas.style.width = '1px';
        wcanvas.style.height = '1px';
        worldOn = false;
      }
      worldSig = '';
      return;
    }
    if (!worldOn) {
      wcanvas.width = Math.round(W * dpr);
      wcanvas.height = Math.round(H * dpr);
      wcanvas.style.width = `${W}px`;
      wcanvas.style.height = `${H}px`;
      worldOn = true;
    }
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wctx.clearRect(0, 0, W, H);
    for (const w of twigs) drawTwig(wctx, w);
    for (const f of foods) drawFood(wctx, f);
    worldSig = sig;
  }

  // 畫面沒變就不重畫：把姿勢量化成簽名，和上一張相同且沒有粒子就跳過（不產生合成畫面，省 GPU）
  let lastSig = '';
  function render(p) {
    const sig = [
      Math.round(p.x * 2), Math.round(p.y * 2), p.face, Math.round(p.yaw * 50), Math.round(p.tilt * 100),
      Math.round(p.squash * 100), Math.round(p.puff * 50), p.air, Math.round(p.wingOpen * 50),
      p.wingOpen > 0.02 ? Math.round(p.ph * 8) : 0, Math.round(p.tail * 50), p.eye, Math.round(p.beak * 10),
      Math.round(p.lookX * 4), Math.round(p.lookY * 4), Math.round(p.cheek * 20), Math.round((p.roll || 0) * 50), boxSize,
    ].join('|');
    if (sig === lastSig && parts.length === 0) {
      renderWorld();
      return;
    }
    lastSig = sig;
    // 鳥的小畫布：位置用 CSS transform 移動（整數 px），鳥在畫布內以小數座標繪製
    const bx = Math.round(bird.x - boxSize / 2);
    const by = Math.round(bird.y - boxSize * 0.62);
    bcanvas.style.transform = `translate(${bx}px, ${by}px)`;
    ctx.setTransform(dpr, 0, 0, dpr, -bx * dpr, -by * dpr);
    ctx.clearRect(bx, by, boxSize, boxSize);
    const hgt = ground - bird.y;
    const k = Math.max(0, 1 - hgt / 280);
    if (k > 0 && hgt < boxSize * 0.38 - 6) {
      ctx.fillStyle = `rgba(40,30,40,${0.2 * k})`;
      ctx.beginPath();
      ctx.ellipse(bird.x, ground + 1, 24 * S * (0.6 + 0.4 * k), 4.5 * S * (0.6 + 0.4 * k), 0, 0, TAU);
      ctx.fill();
    }
    Bird.draw(ctx, p, S);
    drawParts(ctx);
    renderWorld();
  }

  // 測試用：只有頁面預先設了 window.__PET_DEBUG 才會匯出內部狀態
  if (window.__PET_DEBUG) {
    Object.assign(window.__PET_DEBUG, { bird, twigs, setFocus, touch, hit, W: () => W, S: () => S, ground: () => ground });
    Object.defineProperties(window.__PET_DEBUG, {
      act: { get: () => act },
      time: { get: () => time },
    });
  }

  startAct('fly', { tx: bird.x, ty: ground });   // 入場：從天上飛下來
  // 省電的更新節奏：在動、有互動、有東西掉落 / 飄動時全速；發呆約 20 幀；睡覺約 8 幀；專注模式約 4 幀。
  function frameInterval() {
    const FAST = 24;   // 在動 / 有互動時約 40 幀（軟體繪製下比 60 幀省很多，肉眼差異不大）
    if (bird.hot || down || dragging || foods.length) return FAST;
    if (twigs.some((w) => Math.abs(w.a - w.want) > 0.02)) return FAST;
    if (act.name === 'sleep') return parts.length ? 66 : (bird.mode === 'focus' ? 250 : 100);   // Z 飄動 15 幀 / 純睡覺 8 幀 / 專注 4 幀
    if (parts.length) return FAST;
    if (act.name === 'idle') return 40;
    return FAST;
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    render(update(dt));
    const wait = frameInterval();
    // 低功耗時用計時器而不是 requestAnimationFrame：rAF 即使畫面沒變也會觸發一次合成流程
    if (wait > 0) setTimeout(() => frame(performance.now()), wait);
    else requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
