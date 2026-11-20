// curves.js — the little square graph for the Curves adjustment.
// Tap/click to add a point, drag points to bend the curve, double-tap a point to remove it.

import { curveLut } from './adjust.js';

const COLORS = { rgb: '#ececf1', r: '#ff6b6b', g: '#5be37d', b: '#5b9bff' };

export function curvesEditor(params, onChange, onStart) {
  const wrap = document.createElement('div');
  wrap.className = 'curves';
  const tabs = document.createElement('div');
  tabs.className = 'chips';
  let channel = 'rgb';
  for (const [key, label] of [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']]) {
    const b = document.createElement('button');
    b.className = `chip${key === channel ? ' active' : ''}`;
    b.textContent = label;
    b.onclick = () => {
      channel = key;
      for (const c of tabs.children) c.classList.toggle('active', c === b);
      draw();
    };
    tabs.append(b);
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256 * 2;
  canvas.className = 'curves-graph';
  const reset = document.createElement('button');
  reset.className = 'btn small ghost';
  reset.textContent = 'Reset curve';
  reset.onclick = () => { onStart(); params[channel] = [[0, 0], [255, 255]]; draw(); onChange(); };
  wrap.append(tabs, canvas, reset);

  const ctx = canvas.getContext('2d');
  function draw() {
    const S = canvas.width / 255;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 1; k < 4; k++) {
      const v = (canvas.width * k) / 4;
      ctx.moveTo(v, 0); ctx.lineTo(v, canvas.height); ctx.moveTo(0, v); ctx.lineTo(canvas.width, v);
    }
    ctx.moveTo(0, canvas.height); ctx.lineTo(canvas.width, 0);
    ctx.stroke();
    const lut = curveLut(params[channel]);
    ctx.strokeStyle = COLORS[channel];
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let x = 0; x < 256; x++) {
      const y = canvas.height - lut[x] * S;
      x ? ctx.lineTo(x * S, y) : ctx.moveTo(0, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const [x, y] of params[channel]) {
      ctx.beginPath();
      ctx.arc(x * S, canvas.height - y * S, 10, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const toValue = (e) => {
    const r = canvas.getBoundingClientRect();
    return [
      Math.round(Math.min(255, Math.max(0, ((e.clientX - r.left) / r.width) * 255))),
      Math.round(Math.min(255, Math.max(0, (1 - (e.clientY - r.top) / r.height) * 255))),
    ];
  };

  let dragIndex = -1;
  let lastTap = 0;
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const [vx, vy] = toValue(e);
    const pts = params[channel];
    const r = canvas.getBoundingClientRect();
    const tol = (18 / r.width) * 255;
    dragIndex = pts.findIndex(([x, y]) => Math.hypot(x - vx, y - vy) < tol);
    onStart();
    const now = Date.now();
    if (dragIndex >= 0 && now - lastTap < 350 && pts.length > 2) {
      pts.splice(dragIndex, 1); // double tap removes a point
      dragIndex = -1;
    } else if (dragIndex < 0) {
      pts.push([vx, vy]);
      pts.sort((a, b) => a[0] - b[0]);
      dragIndex = pts.findIndex(([x, y]) => x === vx && y === vy);
    }
    lastTap = now;
    draw();
    onChange();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragIndex < 0) return;
    const pts = params[channel];
    const [vx, vy] = toValue(e);
    const minX = dragIndex > 0 ? pts[dragIndex - 1][0] + 1 : 0;
    const maxX = dragIndex < pts.length - 1 ? pts[dragIndex + 1][0] - 1 : 255;
    pts[dragIndex] = [Math.min(maxX, Math.max(minX, vx)), vy];
    draw();
    onChange();
  });
  const end = () => { dragIndex = -1; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  draw();
  return wrap;
}
