const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ============ حالة اللعبة (Server-Authoritative) ============
let tiktokConnection = null;

const game = {
  // إعدادات
  boardSize: 10,
  ships: [
    { name: 'حاملة طائرات', size: 5, count: 1 },
    { name: 'بارجة', size: 4, count: 1 },
    { name: 'مدمرة', size: 3, count: 2 },
    { name: 'غواصة', size: 2, count: 1 }
  ],
  teamNames: { 1: 'الأزرق', 2: 'الأحمر' },

  // حالة
  phase: 'setup', // setup | registration | playing | finished
  isRegistrationOpen: false,
  registeredPlayers: new Map(), // uniqueId -> { user, team }
  teams: { 1: [], 2: [] },

  // اللوحات
  boards: { 1: null, 2: null }, // { grid, ships, shots }

  // الدور
  currentTurn: 1, // 1 أو 2
  lastEvent: null,

  // الإحصائيات
  stats: { 1: { hits: 0, misses: 0, sunk: 0 }, 2: { hits: 0, misses: 0, sunk: 0 } }
};

// ============ توليد اللوحة ============
function createEmptyGrid(size) {
  return Array.from({ length: size }, () => Array(size).fill(0));
}

function placeShipsRandomly(size, shipConfig) {
  const grid = createEmptyGrid(size);
  const ships = [];
  const directions = [[0, 1], [1, 0]]; // أفقي، عمودي

  for (const shipDef of shipConfig) {
    for (let c = 0; c < shipDef.count; c++) {
      let placed = false;
      let attempts = 0;
      while (!placed && attempts < 500) {
        attempts++;
        const size2 = shipDef.size;
        const dir = directions[Math.floor(Math.random() * 2)];
        const row = Math.floor(Math.random() * size);
        const col = Math.floor(Math.random() * size);

        // التحقق من الحدود
        const endRow = row + dir[0] * (size2 - 1);
        const endCol = col + dir[1] * (size2 - 1);
        if (endRow >= size || endCol >= size) continue;

        // التحقق من عدم التداخل (مع هامش 1 خلية)
        let overlap = false;
        for (let r = row - 1; r <= endRow + 1 && !overlap; r++) {
          for (let cc = col - 1; cc <= endCol + 1 && !overlap; cc++) {
            if (r < 0 || cc < 0 || r >= size || cc >= size) continue;
            if (grid[r][cc] !== 0) overlap = true;
          }
        }
        if (overlap) continue;

        // وضع السفينة
        const shipId = ships.length + 1;
        const cells = [];
        for (let i = 0; i < size2; i++) {
          const r = row + dir[0] * i;
          const c2 = col + dir[1] * i;
          grid[r][c2] = shipId;
          cells.push({ r, c: c2 });
        }
        ships.push({ id: shipId, name: shipDef.name, size: size2, cells, hits: 0 });
        placed = true;
      }
    }
  }
  return { grid, ships };
}

// ============ تحويل الإحداثية ============
function parseCoordinate(input, boardSize) {
  if (!input) return null;
  const cleaned = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = cleaned.match(/^([A-Z])(\d{1,2})$/);
  if (!match) return null;
  const col = match[1].charCodeAt(0) - 65; // A=0
  const row = parseInt(match[2]) - 1;
  if (col < 0 || col >= boardSize || row < 0 || row >= boardSize) return null;
  return { row, col };
}

function formatCoordinate(row, col) {
  return String.fromCharCode(65 + col) + (row + 1);
}

// ============ إطلاق طلقة ============
function fireShot(team, row, col) {
  const enemy = team === 1 ? 2 : 1;
  const enemyBoard = game.boards[enemy];
  if (!enemyBoard) return { error: 'اللوحة غير جاهزة' };

  // التحقق من تكرار الطلقة
  if (enemyBoard.shots[row][col] !== 0) {
    return { error: 'تم إطلاق هذه الخلية مسبقاً', duplicate: true };
  }

  const cellValue = enemyBoard.grid[row][col];

  if (cellValue === 0) {
    enemyBoard.shots[row][col] = -1; // miss
    game.stats[team].misses++;
    return { result: 'miss', row, col, coordinate: formatCoordinate(row, col) };
  } else {
    enemyBoard.shots[row][col] = 1; // hit
    game.stats[team].hits++;

    const ship = enemyBoard.ships.find(s => s.id === cellValue);
    ship.hits++;

    if (ship.hits >= ship.size) {
      game.stats[team].sunk++;
      const allSunk = enemyBoard.ships.every(s => s.hits >= s.size);
      return {
        result: allSunk ? 'win' : 'sunk',
        row, col,
        coordinate: formatCoordinate(row, col),
        ship: { name: ship.name, size: ship.size },
        allSunk
      };
    }

    return {
      result: 'hit',
      row, col,
      coordinate: formatCoordinate(row, col),
      ship: { name: ship.name, size: ship.size, hits: ship.hits }
    };
  }
}

// ============ بث حالة اللعبة ============
function broadcastGameState() {
  // لا نرسل مواقع السفن — فقط الطلقات
  const sanitized = {
    phase: game.phase,
    boardSize: game.boardSize,
    teamNames: game.teamNames,
    currentTurn: game.currentTurn,
    stats: game.stats,
    teamCounts: { 1: game.teams[1].length, 2: game.teams[2].length },
    boards: {
      1: game.boards[1] ? {
        shots: game.boards[1].shots,
        shipsRemaining: game.boards[1].ships.filter(s => s.hits < s.size).length,
        totalShips: game.boards[1].ships.length
      } : null,
      2: game.boards[2] ? {
        shots: game.boards[2].shots,
        shipsRemaining: game.boards[2].ships.filter(s => s.hits < s.size).length,
        totalShips: game.boards[2].ships.length
      } : null
    }
  };
  io.emit('game_state', sanitized);
}

// ============ Socket.IO ============
io.on('connection', (socket) => {
  console.log('متصل:', socket.id);

  // إرسال الحالة الحالية
  socket.emit('game_state', {
    phase: game.phase,
    boardSize: game.boardSize,
    teamNames: game.teamNames,
    currentTurn: game.currentTurn,
    stats: game.stats,
    teamCounts: { 1: game.teams[1].length, 2: game.teams[2].length }
  });

  // ===== اتصال TikTok =====
  socket.on('connect_tiktok', async ({ username }) => {
    if (!username) return socket.emit('tiktok_error', 'أدخل اسم الحساب');

    try {
      if (tiktokConnection) {
        try { await tiktokConnection.disconnect(); } catch (e) {}
        tiktokConnection = null;
      }

      tiktokConnection = new TikTokLiveConnection(username, {
        processInitialData: false,
        fetchRoomInfoOnConnect: true
      });

      await tiktokConnection.connect();
      socket.emit('tiktok_connected', { username });
      console.log('✅ متصل بـ TikTok:', username);

      // استقبال التعليقات
      tiktokConnection.on(WebcastEvent.CHAT, (data) => {
        const user = {
          uniqueId: data.user?.uniqueId || 'unknown',
          nickname: data.user?.nickname || data.user?.uniqueId || 'مجهول',
          profilePictureUrl: data.user?.profilePicture?.urls?.[0] || ''
        };
        const comment = (data.comment || '').trim();
        handleComment(user, comment);
      });

    } catch (err) {
      console.error('خطأ TikTok:', err.message);
      socket.emit('tiktok_error', 'فشل الاتصال: ' + err.message);
    }
  });

  // ===== إعدادات اللعبة =====
  socket.on('set_config', (config) => {
    if (config.boardSize) {
      const size = parseInt(config.boardSize);
      if (size >= 5 && size <= 20) game.boardSize = size;
    }
    if (config.ships && Array.isArray(config.ships)) {
      game.ships = config.ships.filter(s => s.size > 0 && s.count > 0);
    }
    if (config.teamNames) {
      game.teamNames = config.teamNames;
    }
    socket.emit('config_saved', { boardSize: game.boardSize, ships: game.ships, teamNames: game.teamNames });
  });

  // ===== فتح/إغلاق التسجيل =====
  socket.on('toggle_registration', () => {
    if (game.phase === 'playing') return;
    game.isRegistrationOpen = !game.isRegistrationOpen;
    game.phase = game.isRegistrationOpen ? 'registration' : 'setup';
    io.emit('registration_status', { open: game.isRegistrationOpen });
    broadcastGameState();
  });

  // ===== بدء اللعبة =====
  socket.on('start_game', () => {
    if (game.teams[1].length === 0 || game.teams[2].length === 0) {
      return socket.emit('game_error', 'يجب أن يكون هناك لاعبان على الأقل في كل فريق');
    }

    // توليد اللوحات
    game.boards[1] = { ...placeShipsRandomly(game.boardSize, game.ships), shots: createEmptyGrid(game.boardSize) };
    game.boards[2] = { ...placeShipsRandomly(game.boardSize, game.ships), shots: createEmptyGrid(game.boardSize) };

    game.stats = { 1: { hits: 0, misses: 0, sunk: 0 }, 2: { hits: 0, misses: 0, sunk: 0 } };
    game.currentTurn = Math.random() < 0.5 ? 1 : 2;
    game.phase = 'playing';
    game.isRegistrationOpen = false;

    io.emit('game_started', { firstTurn: game.currentTurn });
    broadcastGameState();
  });

  // ===== المضيف يطلق طلقة يدوياً =====
  socket.on('host_fire', ({ coordinate }) => {
    if (game.phase !== 'playing') return;
    const parsed = parseCoordinate(coordinate, game.boardSize);
    if (!parsed) return socket.emit('game_error', 'إحداثية غير صحيحة');
    processShot(game.currentTurn, parsed.row, parsed.col, { nickname: 'المضيف', uniqueId: 'host' }, true);
  });

  // ===== إعادة تعيين =====
  socket.on('reset_game', () => {
    game.phase = 'setup';
    game.boards = { 1: null, 2: null };
    game.teams = { 1: [], 2: [] };
    game.registeredPlayers.clear();
    game.stats = { 1: { hits: 0, misses: 0, sunk: 0 }, 2: { hits: 0, misses: 0, sunk: 0 } };
    game.currentTurn = 1;
    game.isRegistrationOpen = false;
    io.emit('game_reset');
    broadcastGameState();
  });
});

// ============ معالجة التعليقات ============
function handleComment(user, comment) {
  const upper = comment.toUpperCase().trim();

  // مرحلة التسجيل
  if (game.isRegistrationOpen) {
    if (game.registeredPlayers.has(user.uniqueId)) return;

    const team = comment === '1' ? 1 : comment === '2' ? 2 : null;
    if (!team) return;

    game.registeredPlayers.set(user.uniqueId, { user, team });
    game.teams[team].push(user);
    io.emit('player_joined', { user, team });
    broadcastGameState();
    return;
  }

  // مرحلة اللعب
  if (game.phase === 'playing') {
    const player = game.registeredPlayers.get(user.uniqueId);
    if (!player) return; // ليس لاعباً

    // التحقق من الدور
    if (player.team !== game.currentTurn) return;

    // التحقق من الإحداثية
    const parsed = parseCoordinate(upper, game.boardSize);
    if (!parsed) return;

    processShot(player.team, parsed.row, parsed.col, user, false);
  }
}

// ============ معالجة الطلقة ============
function processShot(team, row, col, user, isHost) {
  const result = fireShot(team, row, col);

  if (result.error) {
    if (result.duplicate && !isHost) return; // تجاهل بصمت
    io.emit('shot_invalid', { user, coordinate: formatCoordinate(row, col), reason: result.error });
    return;
  }

  const event = {
    ...result,
    team,
    user,
    isHost,
    timestamp: Date.now()
  };
  game.lastEvent = event;

  io.emit('shot_result', event);

  // ننتقل للدور التالي (بغض النظر عن النتيجة)
  if (result.result === 'win') {
    game.phase = 'finished';
    io.emit('game_over', { winner: team, stats: game.stats });
  } else {
    game.currentTurn = team === 1 ? 2 : 1;
  }

  broadcastGameState();
}

// ============ تشغيل السيرفر ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚢 SAMI-BATTLESHIP يعمل على المنفذ ${PORT}`);
});
