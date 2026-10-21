// 程序繪製北長尾山雀（シマエナガ）：雪白、無輪廓線、像大福一樣的蛋形絨毛糰子（頭比身體小一圈、融在一起），
// 很小的臉、小黑豆眼、小嘴、收在身側的灰黑翅膀、黑白相間的長尾巴。
// 以腳底為原點，單位約 1px，由 draw() 縮放與鏡像。身體可在「正面 ↔ 側面」之間連續轉動（yaw），
// 五官用球面投影，所以四分之三視角也成立。
//
// pose 欄位：
//   x, y      腳底位置      face     朝向 (+1 右 / -1 左)
//   yaw       0 正面 … 1 側面（朝 face 方向）
//   roll      繞腳底翻轉（倒掛時為 π）   tilt  前傾（側面時為旋轉，正面時為低頭/抬頭）
//   squash    縱向壓縮（<1 蹲下）  puff 蓬鬆程度   air 0/1 是否離地（收腳）
//   wingOpen  翅膀張開度 0..1   ph 翅膀拍動相位   tail 尾巴上抬量（弧度）
//   eye       'open' | 'wide' | 'blink' | 'happy' | 'closed'
//   beak      嘴張開 0..1   lookX/lookY 視線偏移   cheek 腮紅 0..1
const Bird = (() => {
  const TAU = Math.PI * 2;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const INK = '#1c1a20';

  const rng = (seed) => { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; };

  // ---- 預先畫好的絨毛質感（柔軟的雲霧狀斑塊，沒有連續線條）----
  const FUR_W = 120;   // 單位寬
  const FUR_H = 90;
  const FUR_K = 4;     // 每單位幾個像素
  let fur = null;
  function buildFur() {
    if (typeof document === 'undefined') return null;
    const cv = document.createElement('canvas');
    cv.width = FUR_W * FUR_K;
    cv.height = FUR_H * FUR_K;
    const g = cv.getContext('2d');
    g.scale(FUR_K, FUR_K);
    const r = rng(23);
    g.filter = 'blur(2.2px)';
    for (let i = 0; i < 260; i++) {
      const x = r() * FUR_W;
      const y = r() * FUR_H;
      const rad = 3 + r() * 9;
      const white = r() < 0.55;
      g.fillStyle = white ? 'rgba(255,255,255,0.4)' : 'rgba(140,152,190,0.05)';
      g.beginPath();
      g.ellipse(x, y, rad * 1.3, rad * 0.9, r() * Math.PI, 0, TAU);
      g.fill();
    }
    g.filter = 'blur(0.6px)';
    // 極淡的羽毛尖：短而寬的弧，只在局部出現
    for (let i = 0; i < 70; i++) {
      const x = r() * FUR_W;
      const y = r() * FUR_H;
      const a = r() * TAU;
      g.strokeStyle = r() < 0.7 ? 'rgba(255,255,255,0.3)' : 'rgba(150,160,195,0.045)';
      g.lineWidth = 1.6 + r() * 1.2;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a) * 3, y + Math.sin(a) * 3, x + Math.cos(a + 0.6) * 5.5, y + Math.sin(a + 0.6) * 5.5);
      g.stroke();
    }
    return cv;
  }

  // ---- 輪廓：身體橢圓 + 較小的頭，合成一顆蛋 ----
  function blob(c, cx, cy, rx, ry, seed) {
    const N = 64;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * TAU;
      const k = 1 + 0.011 * (Math.sin(a * 3 + seed) + 0.7 * Math.sin(a * 5 + seed * 2) + 0.5 * Math.sin(a * 9 + seed * 3));
      const x = cx + Math.cos(a) * rx * k;
      const y = cy + Math.sin(a) * ry * k;
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    }
    c.closePath();
  }
  function shape(c, pf, hx) {
    c.beginPath();
    blob(c, 0, -24, 25 * pf, 20.5 * pf, 1.1);
    blob(c, hx, -37, 19.5 * pf, 17 * pf, 4.3);
  }

  // 翅膀：灰黑色，帶白色羽緣
  function wing(c, sx, sy, theta, len, wid, far) {
    c.save();
    c.translate(sx, sy);
    c.rotate(theta);
    c.beginPath();
    c.moveTo(0, -wid * 0.5);
    c.quadraticCurveTo(len * 0.55, -wid * 0.85, len, -wid * 0.1);
    c.quadraticCurveTo(len * 1.04, wid * 0.1, len * 0.94, wid * 0.26);
    c.quadraticCurveTo(len * 0.5, wid * 0.9, 0, wid * 0.5);
    c.closePath();
    const g = c.createLinearGradient(0, -wid * 0.5, 0, wid * 0.6);
    g.addColorStop(0, far ? '#69656f' : '#807c87');
    g.addColorStop(0.6, far ? '#4a4651' : '#5c5863');
    g.addColorStop(1, far ? '#38353e' : '#3d3a44');
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 1.3;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(len * 0.18, wid * 0.5);
    c.quadraticCurveTo(len * 0.55, wid * 0.88, len * 0.93, wid * 0.26);
    c.stroke();
    c.restore();
  }

  function eye(c, ex, ey, vis, mode) {
    const sx = 0.4 + 0.6 * vis;
    c.lineCap = 'round';
    if (mode === 'happy' || mode === 'closed' || mode === 'blink') {
      c.strokeStyle = '#3a3540';
      c.lineWidth = 1.5;
      c.beginPath();
      if (mode === 'happy') c.ellipse(ex, ey + 1.5, 3 * sx, 2.6, 0, Math.PI * 1.1, Math.PI * 1.9);
      else if (mode === 'closed') c.ellipse(ex, ey - 1.2, 3 * sx, 2.2, 0, Math.PI * 0.1, Math.PI * 0.9);
      else { c.moveTo(ex - 2.6 * sx, ey); c.lineTo(ex + 2.6 * sx, ey); }
      c.stroke();
      return;
    }
    const r = mode === 'wide' ? 3.1 : 2.6;
    c.fillStyle = 'rgba(120,128,155,0.07)';
    c.beginPath();
    c.ellipse(ex, ey, r * 2 * sx, r * 2, 0, 0, TAU);
    c.fill();
    c.fillStyle = INK;
    c.beginPath();
    c.ellipse(ex, ey, r * sx, r * 1.04, 0, 0, TAU);
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.beginPath();
    c.ellipse(ex + 0.7 * sx, ey - 0.9, 0.65 * sx, 0.65, 0, 0, TAU);
    c.fill();
  }

  // ---- 身體點陣圖快取 ----
  // 身體（陰影、漸層、絨毛、肚皮、後頸粉褐）只和 puff / 轉身程度 / 縮放有關，量化後預先畫一次，之後重複使用。
  const BS_W = 96;
  const BS_H = 80;
  const BS_OX = 48;    // 圖片左上角相對於腳底原點的位移（單位）
  const BS_OY = 68;
  const sprites = new Map();

  function paintBody(g, pf, hx, sY, k) {
    if (!fur) fur = buildFur();
    // 本體 + 淡淡的外投影（讓白鳥在白底上也看得見）
    shape(g, pf, hx);
    g.save();
    g.filter = `blur(${(0.4 * k).toFixed(2)}px)`;
    g.shadowColor = 'rgba(70,82,120,0.24)';
    g.shadowBlur = 4.6 * k;
    g.shadowOffsetY = 1.2 * k;
    g.fillStyle = '#f5f7fb';
    g.fill();
    g.restore();

    shape(g, pf, hx);
    const lg = g.createLinearGradient(0, -54, 0, -3);
    lg.addColorStop(0, '#ffffff');
    lg.addColorStop(0.6, '#fafbfd');
    lg.addColorStop(1, '#e6e9f2');
    g.fillStyle = lg;
    g.fill();

    g.save();
    shape(g, pf, hx);
    g.clip();
    if (fur) g.drawImage(fur, -FUR_W / 2, -FUR_H + 14, FUR_W, FUR_H);

    // 底部環境陰影 + 暖色肚皮
    const sh = g.createLinearGradient(0, -22, 0, -2);
    sh.addColorStop(0, 'rgba(150,162,198,0)');
    sh.addColorStop(1, 'rgba(150,162,198,0.26)');
    g.fillStyle = sh;
    g.fillRect(-32, -24, 64, 26);
    const bg = g.createRadialGradient(0, -14, 1, 0, -14, 15);
    bg.addColorStop(0, 'rgba(250,224,214,0.38)');
    bg.addColorStop(1, 'rgba(250,224,214,0)');
    g.fillStyle = bg;
    g.fillRect(-30, -32, 60, 34);

    // 側面時後頸到背上那一抹淡粉褐色
    if (sY > 0.05) {
      g.save();
      g.globalAlpha = sY * sY * 0.6;
      g.translate(-12 + hx * 0.3, -41);
      g.rotate(-0.7);
      const mg = g.createRadialGradient(0, 0, 1, 0, 0, 15);
      mg.addColorStop(0, 'rgba(206,164,152,0.95)');
      mg.addColorStop(1, 'rgba(206,164,152,0)');
      g.fillStyle = mg;
      g.beginPath();
      g.ellipse(0, 0, 12, 6, 0, 0, TAU);
      g.fill();
      g.restore();
    }
    g.restore();
  }

  function bodySprite(pf, hxq, k) {
    const key = `${pf}|${hxq}|${k}`;
    let q = sprites.get(key);
    if (q) return q;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(BS_W * k);
    cv.height = Math.ceil(BS_H * k);
    const g = cv.getContext('2d');
    g.scale(k, k);
    g.translate(BS_OX, BS_OY);
    paintBody(g, pf, hxq, hxq / 5, k);
    q = { cv };
    sprites.set(key, q);
    if (sprites.size > 48) sprites.delete(sprites.keys().next().value);   // 最舊的丟掉，記憶體有上限
    return q;
  }

  function draw(c, p, S) {
    if (!fur) fur = buildFur();
    const yaw = clamp(p.yaw, 0, 1);
    const sY = Math.sin(yaw * Math.PI / 2);   // 側面程度
    const cY = Math.cos(yaw * Math.PI / 2);   // 正面程度
    const bow = p.tilt * (1 - yaw);            // 正面時的低頭 / 抬頭量
    const rot = p.tilt * lerp(0.35, 1, yaw);
    const pf = p.puff;
    const hx = 5 * sY;                         // 側面時頭往前

    c.save();
    c.translate(p.x, p.y);
    c.scale(S * p.face, S);
    const m = c.getTransform();
    const kq = Math.max(1, Math.round(Math.hypot(m.a, m.b) * 4) / 4);   // 每單位幾個裝置像素（量化）
    c.rotate((p.roll || 0) + rot);
    const bs = 1 - 0.2 * clamp(bow, -1, 1);
    c.scale(1 + (1 - p.squash) * 0.6 + (1 - bs) * 0.3, p.squash * bs);
    c.lineJoin = 'round';

    // ---- 腿（只露出一小截）----
    c.strokeStyle = '#463e43';
    c.lineWidth = 2;
    c.lineCap = 'round';
    for (const dx of [-6, 6]) {
      c.beginPath();
      if (p.air) {
        c.moveTo(dx, -6);
        c.lineTo(dx * 0.8 - 3 * sY, -3);
      } else {
        const s = Math.sign(dx);
        c.moveTo(dx, -6);
        c.lineTo(dx, -1);
        c.lineTo(dx + s * 3 * cY + 3.6 * sY, 0);
        c.moveTo(dx, -1);
        c.lineTo(dx - s * 1.8 * cY + 1.8 * sY, 0.3);
      }
      c.stroke();
    }

    // ---- 尾巴：黑色，外緣白羽，末端略寬 ----
    c.save();
    c.translate(lerp(3, -18, sY), lerp(-14, -22, sY));
    c.rotate(lerp(1.3, 2.75, sY) + p.tail * (0.4 + 0.6 * sY));
    const L = lerp(22, 56, sY);
    const tw = lerp(2.2, 2.8, sY);
    const tw2 = tw * 1.55;
    c.beginPath();
    c.moveTo(0, -tw);
    c.quadraticCurveTo(L * 0.5, -tw * 1.1, L * 0.78, -tw2);
    c.quadraticCurveTo(L + 3, -tw2 * 0.6, L, 0.4);
    c.quadraticCurveTo(L + 1, tw2 * 0.9, L * 0.78, tw2);
    c.quadraticCurveTo(L * 0.5, tw * 1.1, 0, tw);
    c.closePath();
    c.fillStyle = '#26232b';
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.92)';
    c.lineWidth = 1.2;
    c.lineCap = 'round';
    for (const sg of [-1, 1]) {
      c.beginPath();
      c.moveTo(L * 0.3, sg * (tw * 1.05));
      c.quadraticCurveTo(L * 0.6, sg * tw * 1.15, L * 0.8, sg * (tw2 - 0.2));
      c.stroke();
    }
    c.fillStyle = '#fff';
    c.beginPath();
    c.ellipse(L - 3, 0.2, 2.4, 2, 0, 0, TAU);
    c.fill();
    c.restore();

    // ---- 翅膀參數 ----
    const o = p.wingOpen;
    const f = Math.sin(p.ph);
    const t01 = (1 - f) / 2;
    const foldA = lerp(1.62, 3.0, sY);
    const foldB = lerp(1.52, 3.0, sY);
    const flapA = lerp(lerp(3.57, 4.38, sY), lerp(1.88, 2.0, sY), t01);
    const flapB = lerp(lerp(-0.42, -1.9, sY), lerp(1.26, 2.0, sY), t01);
    const thA = lerp(foldA, flapA, o);
    const thB = lerp(foldB, flapB, o);
    const wLen = lerp(13, 21, sY) * (1 + 0.15 * o);
    const wWid = lerp(6, 7.5, sY);
    const wxA = -22.5 * cY + 4 * sY;
    const wxB = 22.5 * cY + 4 * sY;
    const wy = lerp(-26, -29, sY);
    const spread = o > 0.25 && yaw < 0.4;        // 正面張翅（掙扎、拍翅）：翅膀畫在身體後面
    const farBehind = yaw >= 0.5 || spread;
    if (farBehind) wing(c, wxB, wy, thB, wLen, wWid, true);
    if (spread) wing(c, wxA, wy, thA, wLen, wWid, true);

    // ---- 身體：預先畫好的點陣圖（量化後快取），每幀只貼圖，不再即時做模糊 / 陰影 ----
    {
      const q = bodySprite(Math.round(pf * 50) / 50, Math.round(5 * sY), kq);
      c.drawImage(q.cv, -BS_OX, -BS_OY, BS_W, BS_H);
    }

    // ---- 側面時貼在身上的翅膀 ----
    if (yaw >= 0.4 || spread) {
      c.save();
      c.globalAlpha = spread ? 1 : clamp((yaw - 0.4) / 0.25, 0, 1);
      wing(c, wxA, wy, thA, wLen, wWid, false);
      c.restore();
    }

    // ---- 臉：很小，球面投影 ----
    const al = yaw * Math.PI / 2 + p.lookX * 0.07;
    const R = 15;
    const fy = -35 + p.lookY * 0.8 + bow * 8;

    for (const sg of [-1, 1]) {
      const ang = al + sg * 1.05;
      const vis = Math.cos(ang);
      if (vis < 0.1) continue;
      const bx = hx + R * 1.1 * Math.sin(ang);
      const by = fy + 5.5;
      const rr = 7.5 * Math.sqrt(vis);
      c.globalAlpha = clamp(0.1 + p.cheek * 0.85, 0, 1);
      const cg = c.createRadialGradient(bx, by, 0, bx, by, rr);
      cg.addColorStop(0, 'rgba(255,135,150,0.7)');
      cg.addColorStop(1, 'rgba(255,135,150,0)');
      c.fillStyle = cg;
      c.beginPath();
      c.ellipse(bx, by, rr, rr * 0.8, 0, 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;

    // 嘴：小而圓，幾乎埋在絨毛裡
    const cb = Math.cos(al);
    if (cb > -0.1) {
      const sb = Math.sin(al);
      const bx = hx + 17 * sb;
      const by = fy + 3.6;
      const open = p.beak;
      if (open > 0.05 && cb > 0.2) {
        c.globalAlpha = cb;
        c.fillStyle = '#3a2228';
        c.beginPath();
        c.ellipse(bx, by + 1, 2.3, 1.2 + open * 2, 0, 0, TAU);
        c.fill();
        c.fillStyle = '#e9818c';
        c.beginPath();
        c.ellipse(bx, by + 1.9 + open * 1.2, 1.3, 0.7 + open * 0.7, 0, 0, TAU);
        c.fill();
        c.globalAlpha = 1;
      }
      c.fillStyle = '#4a444c';
      c.strokeStyle = '#4a444c';
      c.lineWidth = 0.9;
      c.beginPath();
      c.moveTo(bx - 2.2 * cb - 0.6 * sb, by - 1.5);
      c.lineTo(bx + 2.2 * cb - 0.6 * sb, by - 1.5 + 2.8 * sb);
      c.lineTo(bx + 3.8 * sb, by + 1.5 * cb + 0.2 * sb - open * 0.5 * sb);
      c.closePath();
      c.fill();
      c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.3)';
      c.beginPath();
      c.ellipse(bx + 0.6 * sb, by - 0.6, 0.8 * cb + 0.4, 0.4, 0, 0, TAU);
      c.fill();
      if (open > 0.05 && sb > 0.3) {
        c.globalAlpha = sb;
        c.fillStyle = '#4a444c';
        c.beginPath();
        c.moveTo(bx - 0.6, by + 1.4);
        c.lineTo(bx + 3.2, by + 2.2 + open * 3);
        c.lineTo(bx - 0.6, by + 3);
        c.closePath();
        c.fill();
        c.globalAlpha = 1;
      }
    }

    // 眼睛：很小，緊貼著嘴兩側
    for (const sg of [-1, 1]) {
      const ang = al + sg * 0.62;
      const vis = Math.cos(ang);
      if (vis < 0.12) continue;
      eye(c, hx + R * Math.sin(ang), fy - 0.8, vis, p.eye);
    }

    c.restore();
  }

  return { draw };
})();

if (typeof module !== 'undefined') module.exports = Bird;
