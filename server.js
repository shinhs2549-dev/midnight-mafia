/**
 * 미드나잇 마피아 - 사회자 진행형 실시간 마피아 게임 서버
 *
 * 핵심 설계
 *  - 사회자(호스트)가 방을 만들고 모든 진행을 컨트롤한다.
 *  - 플레이어는 폰 브라우저로 링크 접속 → 이름 입력 → 방 코드 입력.
 *  - 밤에는 살아있는 전원의 폰이 켜진다(연막). 모두 채팅 + 지목 화면을 본다.
 *      · 마피아  : [마피아 채팅] + [마을 채팅(위장)] + 지목 = 살해 투표
 *      · 경찰    : [마을 채팅] + 지목 = 조사(즉시 결과)
 *      · 의사    : [마을 채팅] + 지목 = 보호
 *      · 시민    : [마을 채팅] + 지목 = 마을 여론 투표(연막 겸 참고용)
 *  - 마을 채팅은 전원 익명(매일 밤 임시번호 재배정). 마피아도 위장 참여.
 *  - 마을 여론 투표는 "시민 진영" 표만 집계, 마피아 표는 조용히 폐기.
 *  - 낮은 오프라인 토론. 사회자가 처형 대상을 눌러 반영.
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// 방 저장소
// ---------------------------------------------------------------------------
const rooms = {}; // code -> room

const ROLE = { MAFIA: 'mafia', POLICE: 'police', DOCTOR: 'doctor', CITIZEN: 'citizen' };
const ROLE_KO = { mafia: '마피아', police: '경찰', doctor: '의사', citizen: '시민' };

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자(I,O,0,1) 제외
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 인원수 기준 추천 구성 (마피아≈1/4.5, 경찰·의사 깔고 나머지 시민)
function suggestConfig(n) {
  if (n < 4) return { mafia: 1, police: 0, doctor: 0, citizen: Math.max(0, n - 1) };
  let mafia = Math.max(1, Math.round(n / 4.5));
  let police = n >= 12 ? 2 : 1;
  let doctor = 1;
  let citizen = n - mafia - police - doctor;
  if (citizen < 0) { police = 1; citizen = n - mafia - police - doctor; }
  if (citizen < 0) { doctor = 0; citizen = n - mafia - police - doctor; }
  if (citizen < 0) { mafia = Math.max(1, mafia - 1); citizen = n - mafia - police - doctor; }
  return { mafia, police, doctor, citizen };
}

function alivePlayers(room) {
  return Object.values(room.players).filter((p) => p.alive && !p.removed);
}
function alivePlayersByRole(room, role) {
  return alivePlayers(room).filter((p) => p.role === role);
}
function deadPlayers(room) {
  return Object.values(room.players).filter((p) => !p.alive && !p.removed);
}

// 죽은 사람에게 관전 정보(전체 역할 공개 + 밤 진행 상황)를 전송
function sendSpectatorState(room) {
  const dead = deadPlayers(room).filter((p) => p.connected);
  if (!dead.length) return;
  const roster = Object.values(room.players)
    .filter((p) => !p.removed)
    .map((p) => ({ name: p.name, roleKo: p.role ? ROLE_KO[p.role] : null, role: p.role, alive: p.alive }));
  const payload = {
    phase: room.phase,
    round: room.round,
    roster,
    night: room.phase === 'night' ? collectNightProgress(room) : null,
  };
  dead.forEach((d) => io.to(d.id).emit('spectator:update', payload));
}

// 새로 죽은 사람을 유령으로 합류시키고 채팅 내역을 전달
function enterGhost(room, player) {
  io.to(player.id).emit('ghost:init', { history: room.ghostChat });
  const sys = { sys: true, text: `${player.name} 님이 유령이 되었습니다.`, t: Date.now() };
  room.ghostChat.push(sys);
  deadPlayers(room).forEach((d) => io.to(d.id).emit('chat:ghost:msg', sys));
}

// ---------------------------------------------------------------------------
// 상태 전송 헬퍼
// ---------------------------------------------------------------------------

// 사회자에게 보내는 전체 현황(갓뷰)
function sendHostState(room) {
  if (!room.hostId) return;
  const players = Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    roleKo: p.role ? ROLE_KO[p.role] : null,
    alive: p.alive,
    connected: p.connected,
    removed: p.removed,
  }));
  io.to(room.hostId).emit('host:state', {
    code: room.code,
    phase: room.phase,
    round: room.round,
    config: room.config,
    started: room.started,
    players,
    counts: tallyCounts(room),
    nightInfo: room.phase === 'night' ? collectNightProgress(room) : null,
    lastResult: room.lastResult || null,
  });
}

function tallyCounts(room) {
  const alive = alivePlayers(room);
  return {
    total: Object.values(room.players).filter((p) => !p.removed).length,
    alive: alive.length,
    mafiaAlive: alive.filter((p) => p.role === ROLE.MAFIA).length,
    townAlive: alive.filter((p) => p.role !== ROLE.MAFIA).length,
    connected: Object.values(room.players).filter((p) => p.connected && !p.removed).length,
  };
}

// 사회자가 밤 동안 누가 무엇을 골랐는지 실시간으로 본다
function collectNightProgress(room) {
  const n = room.night;
  if (!n) return null;
  const nameOf = (id) => (room.players[id] ? room.players[id].name : '—');
  return {
    mafiaPicks: Object.entries(n.mafiaVotes).map(([v, t]) => ({ voter: nameOf(v), target: nameOf(t) })),
    policeChecks: n.policeDone.map((id) => nameOf(id)),
    doctorProtect: Object.values(n.doctorProtects).map((id) => nameOf(id)),
    townVoteCount: Object.keys(n.townVotes).length,
    timerEnd: n.timerEnd,
  };
}

function publicPlayerList(room) {
  // 살아있는 사람 명단(지목/투표용) - 역할은 숨김
  return alivePlayers(room).map((p) => ({ id: p.id, name: p.name }));
}

// ---------------------------------------------------------------------------
// 승리 판정
// ---------------------------------------------------------------------------
function checkWin(room) {
  const alive = alivePlayers(room);
  const mafia = alive.filter((p) => p.role === ROLE.MAFIA).length;
  const town = alive.length - mafia;
  if (mafia === 0) return 'town';
  if (mafia >= town) return 'mafia';
  return null;
}

function endGame(room, winner) {
  room.phase = 'ended';
  room.started = false;
  const reveal = Object.values(room.players)
    .filter((p) => !p.removed)
    .map((p) => ({ name: p.name, roleKo: ROLE_KO[p.role], alive: p.alive }));
  io.to(room.code).emit('game:over', { winner, reveal });
  sendHostState(room);
}

// ---------------------------------------------------------------------------
// 소켓 처리
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // socket.data: { roomCode, isHost, playerId }

  // ---- 사회자: 방 생성 ----
  socket.on('host:create', (_, cb) => {
    const code = genCode();
    rooms[code] = {
      code,
      hostId: socket.id,
      players: {}, // id -> player
      phase: 'lobby',
      round: 0,
      started: false,
      config: { mafia: 0, police: 0, doctor: 0, citizen: 0 },
      night: null,
      lastResult: null,
      ghostChat: [],
    };
    socket.join(code);
    socket.data = { roomCode: code, isHost: true };
    cb && cb({ ok: true, code });
    sendHostState(rooms[code]);
  });

  // ---- 사회자: 재접속(같은 코드로 호스트 복귀) ----
  socket.on('host:reclaim', ({ code }, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, msg: '방을 찾을 수 없어요.' });
    room.hostId = socket.id;
    socket.join(code);
    socket.data = { roomCode: code, isHost: true };
    cb && cb({ ok: true });
    sendHostState(room);
  });

  // ---- 플레이어: 입장 ----
  socket.on('player:join', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim().slice(0, 12);
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, msg: '방 코드가 올바르지 않아요.' });
    if (!name) return cb && cb({ ok: false, msg: '이름을 입력해 주세요.' });

    // 같은 이름으로 끊겼던 사람 → 재접속 처리(역할 유지)
    const existing = Object.values(room.players).find((p) => p.name === name && !p.removed);
    if (existing) {
      if (existing.connected) {
        return cb && cb({ ok: false, msg: '이미 같은 이름이 접속 중이에요. 다른 이름을 써주세요.' });
      }
      // 재접속: 소켓 교체
      delete room.players[existing.id];
      existing.id = socket.id;
      existing.connected = true;
      room.players[socket.id] = existing;
      socket.join(code);
      socket.data = { roomCode: code, isHost: false, playerId: socket.id };
      cb && cb({ ok: true, rejoined: true, name });
      // 진행 중이면 현재 상태 다시 보내주기
      if (existing.role) socket.emit('player:role', { roleKo: ROLE_KO[existing.role], role: existing.role });
      if (room.phase === 'night' && existing.alive) sendNightToPlayer(room, existing);
      if (!existing.alive) {
        socket.emit('you:dead', {});
        socket.emit('ghost:init', { history: room.ghostChat });
        sendSpectatorState(room);
      }
      sendHostState(room);
      return;
    }

    if (room.started) {
      return cb && cb({ ok: false, msg: '게임이 이미 시작됐어요. 사회자에게 문의하세요.' });
    }

    const player = { id: socket.id, name, role: null, alive: true, connected: true, removed: false, selfHeals: 0 };
    room.players[socket.id] = player;
    socket.join(code);
    socket.data = { roomCode: code, isHost: false, playerId: socket.id };
    cb && cb({ ok: true, name });
    sendHostState(room);
  });

  // ---- 사회자: 직업 구성 수정 ----
  socket.on('host:setConfig', ({ config }) => {
    const room = getHostRoom(socket);
    if (!room) return;
    room.config = {
      mafia: Math.max(0, parseInt(config.mafia) || 0),
      police: Math.max(0, parseInt(config.police) || 0),
      doctor: Math.max(0, parseInt(config.doctor) || 0),
      citizen: Math.max(0, parseInt(config.citizen) || 0),
    };
    sendHostState(room);
  });

  // ---- 사회자: 현재 인원 기준 자동 추천 ----
  socket.on('host:autoConfig', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    const n = Object.values(room.players).filter((p) => !p.removed).length;
    room.config = suggestConfig(n);
    sendHostState(room);
  });

  // ---- 사회자: 게임 시작 → 역할 배정 ----
  socket.on('host:start', (_, cb) => {
    const room = getHostRoom(socket);
    if (!room) return;
    const players = Object.values(room.players).filter((p) => !p.removed);
    const sum = room.config.mafia + room.config.police + room.config.doctor + room.config.citizen;
    if (sum !== players.length) {
      return cb && cb({ ok: false, msg: `현재 인원 ${players.length}명인데 직업 합이 ${sum}명이에요.` });
    }
    if (room.config.mafia < 1) {
      return cb && cb({ ok: false, msg: '마피아는 최소 1명 이상이어야 해요.' });
    }

    // 역할 풀 생성 후 셔플 배정
    const pool = []
      .concat(Array(room.config.mafia).fill(ROLE.MAFIA))
      .concat(Array(room.config.police).fill(ROLE.POLICE))
      .concat(Array(room.config.doctor).fill(ROLE.DOCTOR))
      .concat(Array(room.config.citizen).fill(ROLE.CITIZEN));
    const shuffledPlayers = shuffle(players);
    shuffledPlayers.forEach((p, i) => {
      p.role = pool[i];
      p.alive = true;
      p.selfHeals = 0;
    });
    room.ghostChat = [];

    room.started = true;
    room.phase = 'assigned';
    room.round = 0;
    room.lastResult = null;

    // 각자에게 본인 역할 전송
    shuffledPlayers.forEach((p) => {
      io.to(p.id).emit('player:role', { roleKo: ROLE_KO[p.role], role: p.role });
    });

    cb && cb({ ok: true });
    sendHostState(room);
  });

  // ---- 사회자: 밤 시작 ----
  socket.on('host:startNight', ({ seconds }) => {
    const room = getHostRoom(socket);
    if (!room || !room.started) return;
    room.round += 1;
    room.phase = 'night';

    const alive = alivePlayers(room);
    // 매 밤 익명 임시번호 재배정
    const nums = shuffle(alive.map((_, i) => i + 1));
    const anon = {};
    alive.forEach((p, i) => { anon[p.id] = nums[i]; });

    // 토론 마중물: 살아있는 사람 중 무작위 2~3명을 화제로
    const seedCount = Math.min(3, Math.max(2, Math.floor(alive.length / 6)));
    const suspects = shuffle(alive).slice(0, seedCount).map((p) => p.name);

    const dur = Math.max(20, Math.min(300, parseInt(seconds) || 60));
    room.night = {
      mafiaVotes: {},     // voterId -> targetId
      townVotes: {},      // voterId -> targetId (마피아 표는 집계에서 제외)
      doctorProtects: {}, // doctorId -> targetId (의사별 보호 대상)
      policeDone: [],     // 이번 밤 조사 완료한 경찰 id
      anon,
      suspects,
      mafiaChat: [],
      townChat: [],
      timerEnd: Date.now() + dur * 1000,
    };

    alive.forEach((p) => sendNightToPlayer(room, p));
    sendHostState(room);
    sendSpectatorState(room);
  });

  // ---- 밤 지목(역할별 의미가 다름) ----
  socket.on('night:pick', ({ targetId }) => {
    const room = getPlayerRoom(socket);
    if (!room || room.phase !== 'night') return;
    const me = room.players[socket.id];
    if (!me || !me.alive) return;
    const target = room.players[targetId];
    if (!target || !target.alive || target.removed) return;

    if (me.role === ROLE.MAFIA) {
      room.night.mafiaVotes[me.id] = targetId;
      // 마피아끼리 현재 표 상황 공유
      broadcastMafiaTally(room);
    } else if (me.role === ROLE.POLICE) {
      if (room.night.policeDone.includes(me.id)) return; // 밤당 1회
      room.night.policeDone.push(me.id);
      const isMafia = target.role === ROLE.MAFIA;
      io.to(me.id).emit('police:result', { name: target.name, isMafia });
    } else if (me.role === ROLE.DOCTOR) {
      const isSelf = targetId === me.id;
      if (isSelf && (me.selfHeals || 0) >= 2) {
        io.to(me.id).emit('action:ack', { msg: '셀프힐은 게임당 2번까지만 가능해요.' });
        return;
      }
      room.night.doctorProtects[me.id] = targetId;
      io.to(me.id).emit('action:ack', {
        msg: isSelf
          ? `자신을 보호합니다. (셀프힐 ${(me.selfHeals || 0) + 1}/2)`
          : `${target.name} 님을 보호합니다.`,
      });
    } else {
      // 시민(+위장상 다른 town): 마을 여론 투표 (참고용, 시민 표만 집계)
      room.night.townVotes[me.id] = targetId;
      io.to(me.id).emit('action:ack', { msg: `${target.name} 님을 지목했습니다.` });
    }
    sendHostState(room);
    sendSpectatorState(room);
  });

  // ---- 채팅: 마피아 ----
  socket.on('chat:mafia', ({ text }) => {
    const room = getPlayerRoom(socket);
    if (!room || room.phase !== 'night') return;
    const me = room.players[socket.id];
    if (!me || !me.alive || me.role !== ROLE.MAFIA) return;
    text = String(text || '').slice(0, 200).trim();
    if (!text) return;
    const msg = { name: me.name, text, t: Date.now() };
    room.night.mafiaChat.push(msg);
    alivePlayersByRole(room, ROLE.MAFIA).forEach((m) => io.to(m.id).emit('chat:mafia:msg', msg));
  });

  // ---- 채팅: 마을(익명) ----
  socket.on('chat:town', ({ text }) => {
    const room = getPlayerRoom(socket);
    if (!room || room.phase !== 'night') return;
    const me = room.players[socket.id];
    if (!me || !me.alive) return;
    text = String(text || '').slice(0, 200).trim();
    if (!text) return;
    const num = room.night.anon[me.id] || 0;
    const msg = { anon: num, text, t: Date.now() };
    room.night.townChat.push(msg);
    // 살아있는 전원에게(익명) 전송
    alivePlayers(room).forEach((p) => io.to(p.id).emit('chat:town:msg', msg));
  });

  // ---- 채팅: 유령(죽은 사람끼리) ----
  socket.on('chat:ghost', ({ text }) => {
    const room = getPlayerRoom(socket);
    if (!room) return;
    const me = room.players[socket.id];
    if (!me || me.alive || me.removed) return; // 죽은 사람만(완전퇴장 제외)
    text = String(text || '').slice(0, 200).trim();
    if (!text) return;
    const msg = { name: me.name, text, t: Date.now() };
    room.ghostChat.push(msg);
    deadPlayers(room).forEach((d) => io.to(d.id).emit('chat:ghost:msg', msg));
  });

  // ---- 사회자: 밤 종료 → 결과 처리 ----
  socket.on('host:endNight', () => {
    const room = getHostRoom(socket);
    if (!room || room.phase !== 'night') return;
    resolveNight(room);
  });

  // ---- 사회자: 낮 처형(오프라인 투표 결과 반영) ----
  socket.on('host:execute', ({ targetId }) => {
    const room = getHostRoom(socket);
    if (!room) return;
    const target = room.players[targetId];
    if (!target || !target.alive || target.removed) return;
    target.alive = false;
    io.to(target.id).emit('you:dead', {});
    enterGhost(room, target);
    io.to(room.code).emit('day:execution', { name: target.name, roleKo: ROLE_KO[target.role] });
    room.phase = 'day';
    const w = checkWin(room);
    if (w) return endGame(room, w);
    sendHostState(room);
    sendSpectatorState(room);
  });

  // ---- 사회자: 처형 없이 넘어가기(부결) ----
  socket.on('host:skipExecution', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    io.to(room.code).emit('day:execution', { name: null, roleKo: null });
    sendHostState(room);
  });

  // ---- 사회자: 중도 이탈/강제 퇴장 처리 ----
  socket.on('host:eliminate', ({ targetId, asDeath }) => {
    const room = getHostRoom(socket);
    if (!room) return;
    const target = room.players[targetId];
    if (!target) return;
    if (asDeath) {
      target.alive = false;
      io.to(target.id).emit('you:dead', { msg: '게임에서 제외되었습니다.' });
      enterGhost(room, target);
    } else {
      target.removed = true;
      target.alive = false;
      io.to(target.id).emit('removed', {});
    }
    const w = room.started ? checkWin(room) : null;
    if (w) return endGame(room, w);
    sendHostState(room);
  });

  // ---- 사회자: 새 게임(로비로) ----
  socket.on('host:newGame', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    // 완전 퇴장한 사람은 빼고, 나머지는 초기화
    Object.values(room.players).forEach((p) => {
      if (!p.removed) { p.role = null; p.alive = true; p.selfHeals = 0; }
    });
    room.started = false;
    room.phase = 'lobby';
    room.round = 0;
    room.night = null;
    room.lastResult = null;
    room.ghostChat = [];
    io.to(room.code).emit('game:reset', {});
    sendHostState(room);
  });

  // ---- 연결 종료 ----
  socket.on('disconnect', () => {
    const d = socket.data || {};
    const room = rooms[d.roomCode];
    if (!room) return;
    if (d.isHost) {
      // 호스트가 끊김 - 방은 유지(재접속 가능)
      sendHostState(room);
      return;
    }
    const p = room.players[socket.id];
    if (p) {
      p.connected = false;
      sendHostState(room);
    }
  });
});

// ---------------------------------------------------------------------------
// 밤 결과 처리
// ---------------------------------------------------------------------------
function resolveNight(room) {
  const n = room.night;
  // 마피아 살해 대상: 최다 득표(동률이면 무작위)
  const tally = {};
  Object.values(n.mafiaVotes).forEach((t) => { tally[t] = (tally[t] || 0) + 1; });
  let killTarget = null;
  let max = 0;
  const top = [];
  Object.entries(tally).forEach(([t, c]) => {
    if (c > max) { max = c; top.length = 0; top.push(t); }
    else if (c === max) top.push(t);
  });
  if (top.length) killTarget = top[Math.floor(Math.random() * top.length)];

  let killedName = null, killedRole = null, saved = false;
  const protectedIds = new Set(Object.values(n.doctorProtects));
  if (killTarget) {
    if (protectedIds.has(killTarget)) {
      saved = true;
    } else {
      const victim = room.players[killTarget];
      if (victim && victim.alive) {
        victim.alive = false;
        killedName = victim.name;
        killedRole = ROLE_KO[victim.role];
        io.to(victim.id).emit('you:dead', {});
        enterGhost(room, victim);
      }
    }
  }

  // 셀프힐 소진: 자신을 보호한 의사는 카운트 +1
  Object.entries(n.doctorProtects).forEach(([docId, tId]) => {
    if (docId === tId && room.players[docId]) {
      room.players[docId].selfHeals = (room.players[docId].selfHeals || 0) + 1;
    }
  });

  // 마을 여론 집계: "시민 진영"(비마피아) 표만 집계, 마피아 표는 폐기
  const townTally = {};
  Object.entries(n.townVotes).forEach(([voter, t]) => {
    const vp = room.players[voter];
    if (!vp || vp.role === ROLE.MAFIA) return; // 마피아 표 폐기
    if (!room.players[t] || !room.players[t].alive) return;
    townTally[t] = (townTally[t] || 0) + 1;
  });
  const ranking = Object.entries(townTally)
    .map(([id, c]) => ({ name: room.players[id] ? room.players[id].name : '—', votes: c }))
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 5);

  room.phase = 'day';
  room.lastResult = { killedName, killedRole, saved, ranking, round: room.round };

  // 살아있는 전원 + 죽은 사람 모두에게 낮 결과 통보
  io.to(room.code).emit('phase:day', {
    round: room.round,
    killedName,
    saved,
    ranking,
    alive: publicPlayerList(room),
  });

  const w = checkWin(room);
  if (w) return endGame(room, w);
  sendHostState(room);
  sendSpectatorState(room);
}

// ---------------------------------------------------------------------------
// 밤 화면 전송 (역할별 페이로드)
// ---------------------------------------------------------------------------
function sendNightToPlayer(room, p) {
  const n = room.night;
  const base = {
    round: room.round,
    timerEnd: n.timerEnd,
    suspects: n.suspects,
    pickList: publicPlayerList(room).filter((x) => x.id !== p.id), // 자기 자신 제외
    anonNum: n.anon[p.id] || null,
    role: p.role,
    roleKo: ROLE_KO[p.role],
  };
  if (p.role === ROLE.MAFIA) {
    base.mafiaTeam = alivePlayersByRole(room, ROLE.MAFIA).map((m) => m.name);
    base.action = { type: 'kill', label: '오늘 밤 처치할 사람' };
  } else if (p.role === ROLE.POLICE) {
    base.action = { type: 'investigate', label: '오늘 밤 조사할 사람' };
  } else if (p.role === ROLE.DOCTOR) {
    base.action = { type: 'protect', label: '오늘 밤 보호할 사람' };
  } else {
    base.action = { type: 'vote', label: '가장 의심스러운 사람' };
  }
  io.to(p.id).emit('phase:night', base);
}

function broadcastMafiaTally(room) {
  const n = room.night;
  const tally = {};
  Object.values(n.mafiaVotes).forEach((t) => {
    const name = room.players[t] ? room.players[t].name : '—';
    tally[name] = (tally[name] || 0) + 1;
  });
  const list = Object.entries(tally).map(([name, c]) => ({ name, votes: c })).sort((a, b) => b.votes - a.votes);
  alivePlayersByRole(room, ROLE.MAFIA).forEach((m) => io.to(m.id).emit('mafia:tally', { list }));
}

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
function getHostRoom(socket) {
  const d = socket.data || {};
  if (!d.isHost) return null;
  return rooms[d.roomCode] || null;
}
function getPlayerRoom(socket) {
  const d = socket.data || {};
  return rooms[d.roomCode] || null;
}

server.listen(PORT, () => {
  console.log(`🌙 미드나잇 마피아 서버 실행 중 → http://localhost:${PORT}`);
});
