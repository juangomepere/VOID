const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ── CONSTANTS ──────────────────────────────────────────────────────────────────
const COLS = 25, ROWS = 25;
const MAX_PLAYERS = 25;

const PALETTE = [
  '#00E5FF','#FF6B35','#39FF14','#FF00FF','#FFD700',
  '#FF1744','#7C4DFF','#00E676','#FF6D00','#18FFFF',
  '#FF4081','#69F0AE','#40C4FF','#EA80FC','#FFFF00',
  '#FF6E40','#B2FF59','#84FFFF','#FF80AB','#CCF600',
  '#FFFFFF','#FF5252','#448AFF','#F4FF81','#CCFF90'
];

const PHASES = [
  { name: 'FASE CIEGA',  rate: 8,   end: 180 },
  { name: 'FASE PULSO',  rate: 15,  end: 360 },
  { name: 'FASE SOMBRA', rate: 30,  end: 540 },
  { name: 'LA NOCHE',    rate: 60,  end: Infinity }
];

const CLOCK_TYPES = [
  { type: 'bronze', t: 20,  color: '#C8922A', weight: 60 },
  { type: 'silver', t: 45,  color: '#8BAEC4', weight: 25 },
  { type: 'gold',   t: 90,  color: '#D4A800', weight: 10 },
  { type: 'shadow', t: -40, color: '#C8922A', weight: 5  }
];

const START_POSITIONS = [
  {x:1,y:1},{x:23,y:1},{x:1,y:23},{x:23,y:23},
  {x:12,y:0},{x:12,y:24},{x:0,y:12},{x:24,y:12},
  {x:6,y:1},{x:18,y:1},{x:1,y:6},{x:23,y:6},
  {x:1,y:18},{x:23,y:18},{x:6,y:23},{x:18,y:23},
  {x:6,y:6},{x:18,y:6},{x:6,y:18},{x:18,y:18},
  {x:12,y:6},{x:12,y:18},{x:6,y:12},{x:18,y:12},
  {x:12,y:12}
];

// ── SEEDED RNG ─────────────────────────────────────────────────────────────────
function mulberry32(a) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── MAZE GENERATION ────────────────────────────────────────────────────────────
function genMaze(seed) {
  const rng = mulberry32(seed);
  const W = Array.from({length: ROWS}, () =>
    Array.from({length: COLS}, () => ({n:true, s:true, e:true, w:true}))
  );
  const visited = Array.from({length: ROWS}, () => new Array(COLS).fill(false));

  function sh(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function carve(r, c) {
    visited[r][c] = true;
    for (const [dr, dc, wall, opp] of sh([
      [-1,0,'n','s'],[1,0,'s','n'],[0,1,'e','w'],[0,-1,'w','e']
    ])) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && !visited[nr][nc]) {
        W[r][c][wall] = false;
        W[nr][nc][opp] = false;
        carve(nr, nc);
      }
    }
  }
  carve(0, 0);
  return W;
}

// ── ROOM STATE ─────────────────────────────────────────────────────────────────
const rooms = new Map();
let deviceCounter = 0;

function genCode() {
  let code;
  do { code = String(Math.floor(Math.random() * 10000)).padStart(4, '0'); }
  while (rooms.has(code));
  return code;
}

function getPhase(gtime) {
  for (let i = 0; i < PHASES.length - 1; i++) {
    if (gtime < PHASES[i].end) return i;
  }
  return PHASES.length - 1;
}

function pickClockType(goldCount) {
  const types = CLOCK_TYPES.filter(t => t.type !== 'gold' || goldCount < 2);
  const total = types.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of types) { r -= t.weight; if (r <= 0) return t; }
  return types[types.length - 1];
}

function freeCell(gs, players) {
  const occupied = new Set();
  for (const p of players.values()) occupied.add(`${p.x},${p.y}`);
  for (const c of gs.clocks) occupied.add(`${c.x},${c.y}`);
  for (let i = 0; i < 300; i++) {
    const x = Math.floor(Math.random() * COLS);
    const y = Math.floor(Math.random() * ROWS);
    if (!occupied.has(`${x},${y}`)) return {x, y};
  }
  return null;
}

let clockIdCounter = 0;
function spawnClock(room) {
  const gs = room.gameState;
  const pos = freeCell(gs, room.players);
  if (!pos) return;
  const ctype = pickClockType(gs.goldCount);
  if (ctype.type === 'gold') gs.goldCount++;
  const clock = {
    id: `c${++clockIdCounter}`,
    x: pos.x, y: pos.y,
    type: ctype.type, t: ctype.t, color: ctype.color
  };
  gs.clocks.push(clock);
  broadcastToRoom(room, {type: 'clockSpawned', clock});
}

function breatheMaze(room) {
  const gs = room.gameState;
  const maze = gs.maze;
  const affected = [];
  const count = Math.floor(((COLS - 1) * ROWS + COLS * (ROWS - 1)) * 0.15);
  for (let i = 0; i < count; i++) {
    const r = Math.floor(Math.random() * ROWS);
    const c = Math.floor(Math.random() * COLS);
    if (c < COLS - 1 && Math.random() < 0.5) {
      maze[r][c].e = !maze[r][c].e;
      maze[r][c+1].w = maze[r][c].e;
      affected.push({r, c, side:'e', open: !maze[r][c].e});
    } else if (r < ROWS - 1) {
      maze[r][c].s = !maze[r][c].s;
      maze[r+1][c].n = maze[r][c].s;
      affected.push({r, c, side:'s', open: !maze[r][c].s});
    }
  }
  broadcastToRoom(room, {type: 'mazeBreath', cells: affected});
}

// ── BROADCAST HELPERS ──────────────────────────────────────────────────────────
function broadcastToRoom(room, msg) {
  const str = JSON.stringify(msg);
  for (const [, device] of room.devices) {
    if (device.ws.readyState === 1) device.ws.send(str);
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function lobbyState(room) {
  return {
    code: room.code,
    host: room.host,
    players: [...room.players.values()].map(p => ({
      id: p.id, deviceId: p.deviceId, slot: p.slot, color: p.color
    }))
  };
}

// ── GAME LIFECYCLE ─────────────────────────────────────────────────────────────
function startGame(room) {
  const seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  const maze = genMaze(seed);

  const pArr = [...room.players.values()];
  pArr.forEach((p, i) => {
    const pos = START_POSITIONS[i % START_POSITIONS.length];
    p.x = pos.x; p.y = pos.y;
    p.time = 60; p.score = 0; p.alive = true;
  });

  room.gameState = {
    seed, maze, clocks: [],
    phase: 0, gtime: 0,
    goldCount: 0, spawnCD: PHASES[0].rate, breathCD: 180
  };
  room.status = 'playing';

  const playersOut = [...room.players.values()].map(p => ({
    id: p.id, deviceId: p.deviceId, slot: p.slot, color: p.color,
    x: p.x, y: p.y, time: p.time, score: p.score, alive: p.alive
  }));
  broadcastToRoom(room, {type: 'gameStart', seed, players: playersOut});

  let lastTick = Date.now();
  room.gameLoop = setInterval(() => {
    const now = Date.now();
    const dt = Math.min((now - lastTick) / 1000, 0.1);
    lastTick = now;
    tickGame(room, dt);
  }, 50);
}

function tickGame(room, dt) {
  const gs = room.gameState;
  if (!gs || room.status !== 'playing') return;

  gs.gtime += dt;

  // Phase transitions
  const newPhase = getPhase(gs.gtime);
  if (newPhase !== gs.phase) {
    gs.phase = newPhase;
    broadcastToRoom(room, {type: 'phaseChange', phase: gs.phase});
  }

  // Decrement timers
  const wasAliveCount = [...room.players.values()].filter(p => p.alive).length;
  for (const [, p] of room.players) {
    if (!p.alive) continue;
    p.time -= dt;
    if (p.time <= 0) {
      p.time = 0;
      p.alive = false;
      broadcastToRoom(room, {type: 'eliminated', playerId: p.id});
    }
  }

  // Clock pickups
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    const ci = gs.clocks.findIndex(c => c.x === p.x && c.y === p.y);
    if (ci !== -1) {
      const clock = gs.clocks.splice(ci, 1)[0];
      p.time = Math.max(0, p.time + clock.t);
      p.score++;
      broadcastToRoom(room, {type: 'clockCollected', clockId: clock.id, playerId: p.id, clockX: clock.x, clockY: clock.y});
    }
  }

  // Game-over check
  const alive = [...room.players.values()].filter(p => p.alive);
  if (alive.length <= 1 && wasAliveCount > 0) {
    endGame(room, alive[0] || null);
    return;
  }

  // Clock spawning
  gs.spawnCD -= dt;
  if (gs.spawnCD <= 0) {
    spawnClock(room);
    gs.spawnCD = PHASES[gs.phase].rate;
  }

  // Maze breathing
  gs.breathCD -= dt;
  if (gs.breathCD <= 0) {
    breatheMaze(room);
    gs.breathCD = 180;
  }

  // Broadcast tick
  broadcastToRoom(room, {
    type: 'tick',
    players: [...room.players.values()].map(p => ({
      id: p.id, deviceId: p.deviceId, slot: p.slot, color: p.color,
      x: p.x, y: p.y, time: p.time, score: p.score, alive: p.alive
    })),
    clocks: gs.clocks,
    phase: gs.phase,
    gtime: gs.gtime
  });
}

function endGame(room, winner) {
  if (room.gameLoop) { clearInterval(room.gameLoop); room.gameLoop = null; }
  room.status = 'ended';
  broadcastToRoom(room, {
    type: 'gameOver',
    winner: winner ? winner.id : null,
    stats: [...room.players.values()].map(p => ({
      id: p.id, deviceId: p.deviceId, color: p.color, time: p.time, score: p.score
    }))
  });
}

function removeDevice(deviceId, roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const device = room.devices.get(deviceId);
  if (!device) return;

  // Eliminate alive players from this device
  if (room.status === 'playing') {
    for (const slot of device.slots) {
      if (slot && slot.alive) {
        slot.alive = false;
        broadcastToRoom(room, {type: 'eliminated', playerId: slot.id});
      }
    }
  }

  // Remove device and its players
  for (const slot of device.slots) {
    if (slot) room.players.delete(slot.id);
  }
  room.devices.delete(deviceId);

  if (room.devices.size === 0) {
    if (room.gameLoop) clearInterval(room.gameLoop);
    rooms.delete(roomCode);
    return;
  }

  // Reassign host if needed
  if (room.host === deviceId) {
    room.host = room.devices.keys().next().value;
  }

  if (room.status === 'playing') {
    const alive = [...room.players.values()].filter(p => p.alive);
    if (alive.length <= 1) endGame(room, alive[0] || null);
  } else if (room.status === 'lobby') {
    broadcastToRoom(room, {type: 'lobbyUpdate', ...lobbyState(room)});
  }
}

// ── HTTP SERVER ────────────────────────────────────────────────────────────────
const htmlPath = path.join(__dirname, 'index.html');
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(htmlPath);
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end('Server error: ' + e.message);
    }
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ── WEBSOCKET SERVER ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({server});

wss.on('connection', (ws) => {
  const deviceId = `dev_${++deviceCounter}`;
  let deviceRoomCode = null;

  sendTo(ws, {type: 'init', deviceId});

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      case 'createRoom': {
        if (deviceRoomCode) return; // already in a room
        const code = genCode();
        rooms.set(code, {
          code,
          host: deviceId,
          status: 'lobby',
          devices: new Map([[deviceId, {ws, slots: [null, null]}]]),
          players: new Map(),
          gameState: null,
          gameLoop: null
        });
        deviceRoomCode = code;
        sendTo(ws, {type: 'roomCreated', code, host: deviceId, isHost: true});
        break;
      }

      case 'joinRoom': {
        if (deviceRoomCode) return;
        const code = String(msg.code || '').trim().toUpperCase().padStart(4, '0');
        const normalCode = String(msg.code || '').trim();
        const room = rooms.get(normalCode);
        if (!room) { sendTo(ws, {type: 'error', msg: 'Room not found'}); return; }
        if (room.status !== 'lobby') { sendTo(ws, {type: 'error', msg: 'Game already in progress'}); return; }
        room.devices.set(deviceId, {ws, slots: [null, null]});
        deviceRoomCode = normalCode;
        sendTo(ws, {type: 'joinedRoom', isHost: false, ...lobbyState(room)});
        broadcastToRoom(room, {type: 'lobbyUpdate', ...lobbyState(room)});
        break;
      }

      case 'setColor': {
        const room = rooms.get(deviceRoomCode);
        if (!room || room.status !== 'lobby') return;
        const {slot, color} = msg;
        if (typeof slot !== 'number' || slot < 0 || slot > 1) return;
        if (!PALETTE.includes(color)) return;

        // Check if another player (different device) has this color
        for (const [, p] of room.players) {
          if (p.color === color && p.deviceId !== deviceId) {
            sendTo(ws, {type: 'colorTaken', slot, color}); return;
          }
        }

        // Check if the OTHER local slot on this device has this color
        const otherSlot = 1 - slot;
        const otherPlayerId = `${deviceId}_${otherSlot}`;
        if (room.players.has(otherPlayerId) && room.players.get(otherPlayerId).color === color) {
          sendTo(ws, {type: 'colorTaken', slot, color}); return;
        }

        // Room capacity
        const playerId = `${deviceId}_${slot}`;
        if (!room.players.has(playerId) && room.players.size >= MAX_PLAYERS) {
          sendTo(ws, {type: 'error', msg: 'Room is full (25 players)'}); return;
        }

        let player = room.players.get(playerId);
        if (!player) {
          player = {id: playerId, deviceId, slot, color, x:0, y:0, time:60, score:0, alive:true};
          room.players.set(playerId, player);
          room.devices.get(deviceId).slots[slot] = player;
        } else {
          player.color = color;
        }

        broadcastToRoom(room, {type: 'lobbyUpdate', ...lobbyState(room)});
        break;
      }

      case 'removeSlot': {
        const room = rooms.get(deviceRoomCode);
        if (!room || room.status !== 'lobby') return;
        const {slot} = msg;
        const playerId = `${deviceId}_${slot}`;
        room.players.delete(playerId);
        const dev = room.devices.get(deviceId);
        if (dev) dev.slots[slot] = null;
        broadcastToRoom(room, {type: 'lobbyUpdate', ...lobbyState(room)});
        break;
      }

      case 'startGame': {
        const room = rooms.get(deviceRoomCode);
        if (!room || room.host !== deviceId || room.status !== 'lobby') return;
        if (room.players.size === 0) {
          sendTo(ws, {type: 'error', msg: 'Pick a color first'}); return;
        }
        startGame(room);
        break;
      }

      case 'move': {
        const room = rooms.get(deviceRoomCode);
        if (!room || room.status !== 'playing') return;
        const {slot, dir} = msg;
        if (typeof slot !== 'number' || !['n','s','e','w'].includes(dir)) return;
        const playerId = `${deviceId}_${slot}`;
        const player = room.players.get(playerId);
        if (!player || !player.alive) return;

        const maze = room.gameState.maze;
        const {x, y} = player;
        const cell = maze[y][x];

        const DIRS = {n:['n', 0,-1], s:['s', 0,1], e:['e', 1,0], w:['w', -1,0]};
        const [wall, dx, dy] = DIRS[dir];

        if (cell[wall]) {
          sendTo(ws, {type: 'wallHit', slot, x, y, dir});
        } else {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) {
            player.x = nx; player.y = ny;
          }
        }
        break;
      }

      case 'playAgain': {
        const room = rooms.get(deviceRoomCode);
        if (!room || room.host !== deviceId || room.status !== 'ended') return;
        for (const p of room.players.values()) {
          p.time = 60; p.score = 0; p.alive = true;
        }
        room.status = 'lobby';
        broadcastToRoom(room, {type: 'returnToLobby', ...lobbyState(room)});
        break;
      }
    }
  });

  const cleanup = () => {
    if (deviceRoomCode) removeDevice(deviceId, deviceRoomCode);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`VOID server → http://localhost:${PORT}`);
});
