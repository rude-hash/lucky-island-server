const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const SECRET_STAFF_CODE = "lucky1004";
let users = {};
let gameState = { phase: 'lobby', data: null, bets: {}, selections: {}, timer: 0 };
let timerInterval = null;

function checkBeggars() {
    Object.values(users).forEach(u => { if (u.balance < 0) u.balance = 0; u.isBeggar = (u.balance <= 0); });
}
function broadcastUsers() { io.emit('updateUsers', Object.values(users)); }
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

function emitRacingBetCounts() {
    const counts = {};
    Object.values(gameState.bets).forEach(b => { counts[b.choice] = (counts[b.choice] || 0) + 1; });
    io.emit('racingBetCounts', counts);
}

// 타이머 종료 시 미제출 유저 자동 확정
function autoFinalizeBets() {
    Object.keys(gameState.selections).forEach(uid => {
        if (!gameState.bets[uid] && users[uid] && !users[uid].isBeggar) {
            const amt = gameState.pendingAmounts?.[uid];
            if (amt && amt > 0 && amt <= users[uid].balance) {
                gameState.bets[uid] = { choice: gameState.selections[uid], amount: amt };
            }
        }
    });
}

function startTimer(callback) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        gameState.timer--;
        io.emit('timerUpdate', gameState.timer);
        if (gameState.timer <= 0) {
            clearInterval(timerInterval); timerInterval = null;
            autoFinalizeBets();
            callback();
        }
    }, 1000);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        const isStaff = (data.secretCode === SECRET_STAFF_CODE) || (data.isStaff === true);
        // 같은 닉네임의 기존 유저 찾기 (구 소켓 정리)
        const existing = Object.values(users).find(u => u.nickname === data.nickname && u.id !== socket.id);
        if (existing) {
            const oldId = existing.id;
            delete users[oldId];
            // 구 소켓 disconnect가 새 유저를 지우지 않도록 마킹
            if (io.sockets.sockets.get(oldId)) {
                io.sockets.sockets.get(oldId)._replaced = true;
            }
            users[socket.id] = {
                ...existing,
                id: socket.id,
                profilePic: data.profilePic || existing.profilePic,
                isStaff: existing.isStaff || isStaff
            };
        } else {
            users[socket.id] = {
                id: socket.id, nickname: data.nickname,
                profilePic: data.profilePic || `https://api.dicebear.com/7.x/avataaars/svg?seed=${Math.random()}`,
                balance: 100000, isBeggar: false, isStaff: isStaff
            };
        }
        socket.emit('joinSuccess', users[socket.id]);
        broadcastUsers();
    });

    socket.on('updateProfile', (data) => {
        const user = users[socket.id];
        if (!user) return;
        if (data.nickname && data.nickname.trim()) user.nickname = data.nickname.trim();
        if (data.profilePic) user.profilePic = data.profilePic;
        socket.emit('profileUpdated', { ...user });
        broadcastUsers();
    });

    socket.on('sendMessage', (text) => {
        const user = users[socket.id];
        if (!user || !text || !text.trim()) return;
        io.emit('receiveMessage', {
            id: Date.now() + Math.random(), senderId: user.id,
            nickname: user.nickname, profilePic: user.profilePic,
            isBeggar: user.isBeggar, isStaff: user.isStaff || false,
            text: text.trim()
        });
    });

    // ===== 선택 (배팅/경마 공통) =====
    socket.on('selectChoice', (idx) => {
        if (gameState.phase === 'lobby') return;
        const user = users[socket.id];
        if (!user || user.isBeggar) return;
        gameState.selections[socket.id] = idx;
        // 경마: 이미 제출된 배팅의 선택지도 변경 (재선택)
        if (gameState.bets[socket.id]) {
            gameState.bets[socket.id].choice = idx;
            if (gameState.phase === 'racing') emitRacingBetCounts();
        }
    });

    // 배팅액 임시 저장 (자동 확정용)
    socket.on('updateBetAmount', (amt) => {
        if (gameState.phase === 'lobby') return;
        if (!gameState.pendingAmounts) gameState.pendingAmounts = {};
        gameState.pendingAmounts[socket.id] = parseInt(amt) || 0;
    });

    // ===== 배팅 제출 (재제출 가능) =====
    socket.on('submitBet', (data) => {
        const user = users[socket.id];
        if (!user || user.isBeggar) return;
        if (!data.amount || data.amount <= 0 || data.amount > user.balance) return;
        if (data.choice === null || data.choice === undefined) return;
        gameState.bets[socket.id] = { choice: data.choice, amount: data.amount };
        delete gameState.selections[socket.id]; // 확정되었으므로 선택 목록에서 제거
        socket.emit('betConfirmed', data);
        if (gameState.phase === 'racing') emitRacingBetCounts();
    });

    // ===== 배팅게임 =====
    socket.on('startBettingGame', () => {
        if (!users[socket.id]?.isStaff) return;
        const labels = ['1번', '2번', '3번', '4번', '5번'];
        gameState = { phase: 'betting', data: labels, bets: {}, selections: {}, pendingAmounts: {}, timer: 40 };
        io.emit('gameStarted', { phase: 'betting', data: labels, timer: 40 });
        startTimer(calcBettingResults);
    });

    function calcBettingResults() {
        const effects = ['배팅액 ×2', '배팅액 ×1.5', '본전', '배팅액 -20%', '배팅액 -50%'];
        const multipliers = [2, 1.5, 1, 0.8, 0.5];
        const shuffledIndices = shuffle([0, 1, 2, 3, 4]);
        const effectMap = {};
        for (let i = 0; i < 5; i++) effectMap[i] = shuffledIndices[i];

        const payouts = {};
        const resultByEffect = {};
        const userResults = {};

        Object.keys(gameState.bets).forEach(uid => {
            const bet = gameState.bets[uid];
            if (!users[uid]) return;
            const effIdx = effectMap[bet.choice];
            const newAmt = Math.floor(bet.amount * multipliers[effIdx]);
            const change = newAmt - bet.amount;
            users[uid].balance += change;
            payouts[uid] = change;
            if (!resultByEffect[effIdx]) resultByEffect[effIdx] = [];
            resultByEffect[effIdx].push(uid);
            userResults[uid] = { effect: effects[effIdx], effectIdx: effIdx, change, betAmount: bet.amount, choice: bet.choice };
        });

        // 잭팟: 2배 당첨자 중 1명 → 배팅액 5배 추가
        let jackpotUser = null;
        const twiceWinners = resultByEffect[0] || [];
        if (twiceWinners.length > 0) {
            const luckyId = twiceWinners[Math.floor(Math.random() * twiceWinners.length)];
            const bonus = Math.floor(gameState.bets[luckyId].amount * 5);
            users[luckyId].balance += bonus;
            payouts[luckyId] = (payouts[luckyId] || 0) + bonus;
            jackpotUser = { ...users[luckyId], bonus };
        }

        // 왕자와 거지: -50% 당첨자 중 1명 ↔ 1위 스와핑
        let swapEvent = null;
        const halfLosers = resultByEffect[4] || [];
        if (halfLosers.length > 0) {
            const poorId = halfLosers[Math.floor(Math.random() * halfLosers.length)];
            const sorted = Object.values(users).sort((a, b) => b.balance - a.balance);
            const richUser = sorted[0];
            if (richUser && richUser.id !== poorId) {
                const tmp = users[poorId].balance;
                users[poorId].balance = users[richUser.id].balance;
                users[richUser.id].balance = tmp;
                swapEvent = { poor: { ...users[poorId] }, rich: { ...users[richUser.id] } };
            }
        }

        checkBeggars(); broadcastUsers();
        const revealMap = {};
        for (let i = 0; i < 5; i++) revealMap[i] = { label: effects[effectMap[i]], multiplier: multipliers[effectMap[i]] };
        io.emit('bettingResults', { users: Object.values(users), payouts, userResults, revealMap, jackpotUser, swapEvent });
        gameState.phase = 'lobby';
    }

    // ===== 경마게임 =====
    socket.on('startHorseRacing', (horses) => {
        if (!users[socket.id]?.isStaff) return;
        gameState = { phase: 'racing', data: horses, bets: {}, selections: {}, pendingAmounts: {}, timer: 60 };
        io.emit('gameStarted', { phase: 'racing', data: horses, timer: 60 });
        startTimer(calcRacingResults);
    });

    function calcRacingResults() {
        const winIdx = Math.floor(Math.random() * gameState.data.length);
        let pool = 0, winners = [];
        const payouts = {};
        Object.keys(gameState.bets).forEach(uid => {
            if (!users[uid]) return;
            const bet = gameState.bets[uid];
            pool += bet.amount;
            users[uid].balance -= bet.amount;
            payouts[uid] = -bet.amount;
            if (bet.choice === winIdx) winners.push(uid);
        });

        let surprise = null;
        if (winners.length > 0) {
            const prize = Math.floor(pool / winners.length);
            winners.forEach(uid => { users[uid].balance += prize; payouts[uid] = (payouts[uid] || 0) + prize; });
        } else if (pool > 0) {
            // 깜짝 룰: 전체 유저 중 최저 잔액자 (거지 포함), 동률이면 랜덤 1명
            const allUsers = Object.values(users);
            if (allUsers.length > 0) {
                const minBal = Math.min(...allUsers.map(u => u.balance));
                const lowestGroup = allUsers.filter(u => u.balance === minBal);
                const luckyUser = lowestGroup[Math.floor(Math.random() * lowestGroup.length)];
                users[luckyUser.id].balance += pool;
                payouts[luckyUser.id] = (payouts[luckyUser.id] || 0) + pool;
                surprise = { id: luckyUser.id, nickname: luckyUser.nickname, profilePic: luckyUser.profilePic, pool };
            }
        }

        checkBeggars(); broadcastUsers();
        io.emit('racingResults', {
            users: Object.values(users), winIndex: winIdx, pool, payouts,
            surprise, winnerCount: winners.length
        });
        gameState.phase = 'lobby';
    }

    // ===== 거지회생 =====
    socket.on('resurrectBeggars', () => {
        if (!users[socket.id]?.isStaff) return;
        let count = 0;
        Object.values(users).forEach(u => { if (u.balance <= 0) { u.balance = 1000; u.isBeggar = false; count++; } });
        broadcastUsers();
        io.emit('resurrectionEvent', { count });
    });

    // ===== 운명에 맡기기 (거지 제외) =====
    socket.on('triggerFateEvent', () => {
        if (!users[socket.id]?.isStaff) return;
        // 거지가 아닌 유저만 대상
        const ids = Object.keys(users).filter(id => !users[id].isBeggar);
        if (ids.length < 2) return;

        const eventTypes = ["Pinch", "Swap", "Depression", "BeggarPass", "Lotto", "Reroll"];
        const chosen = eventTypes[Math.floor(Math.random() * eventTypes.length)];
        let changes = {}; let msg = "";
        Object.keys(users).forEach(id => changes[id] = 0);

        switch (chosen) {
            case "Pinch": {
                const n = Math.max(1, Math.floor(ids.length * (0.3 + Math.random() * 0.4)));
                const t = shuffle(ids).slice(0, n);
                const pct = 10 + Math.floor(Math.random() * 11);
                msg = `💸 짤짤이 뿌리기: ${n}명의 잔액 ${pct}% 증가!`;
                t.forEach(id => { const b = Math.floor(users[id].balance * pct / 100); users[id].balance += b; changes[id] = b; });
                break;
            }
            case "Swap": {
                const pc = Math.max(1, Math.floor(ids.length * 0.3));
                const t = shuffle(ids).slice(0, pc * 2);
                msg = `😱 왕자와 거지: ${Math.floor(t.length / 2)}쌍의 잔액 교체!`;
                for (let i = 0; i + 1 < t.length; i += 2) {
                    const oA = users[t[i]].balance, oB = users[t[i+1]].balance;
                    users[t[i]].balance = oB; users[t[i+1]].balance = oA;
                    changes[t[i]] = oB - oA; changes[t[i+1]] = oA - oB;
                }
                break;
            }
            case "Depression": {
                const n = Math.max(1, Math.floor(ids.length * (0.2 + Math.random() * 0.3)));
                const t = shuffle(ids).slice(0, n);
                msg = `📉 대공황: ${n}명의 잔액 30% 감소!`;
                t.forEach(id => { const l = Math.floor(users[id].balance * 0.3); users[id].balance -= l; changes[id] = -l; });
                break;
            }
            case "BeggarPass": {
                const n = ids.length < 2 ? 1 : Math.max(1, Math.floor(ids.length * 0.3));
                const t = shuffle(ids).slice(0, n);
                msg = `🧹 거지합격: ${n}명 전 재산 몰수!`;
                t.forEach(id => { changes[id] = -users[id].balance; users[id].balance = 0; });
                break;
            }
            case "Lotto": {
                const w = ids[Math.floor(Math.random() * ids.length)];
                const b = users[w].balance * 4;
                users[w].balance += b; changes[w] = b;
                msg = `💎 로또 당첨: ${users[w].nickname}님 잔액 5배!`;
                break;
            }
            case "Reroll": {
                const n = Math.max(1, Math.floor(ids.length * 0.5));
                const t = shuffle(ids).slice(0, n);
                msg = `🎲 리세마라: ${n}명 잔액 리롤!`;
                t.forEach(id => { const old = users[id].balance; users[id].balance = Math.floor(Math.random() * 145000) + 5000; changes[id] = users[id].balance - old; });
                break;
            }
        }
        checkBeggars();
        const top = Object.entries(changes).filter(([,v]) => v !== 0).sort((a,b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0,5).map(([id, amt]) => ({ ...users[id], change: amt }));
        broadcastUsers();
        io.emit('fateEvent', { msg, topUsers: top });
    });

    socket.on('endGame', () => {
        if (!users[socket.id]?.isStaff) return;
        const sorted = Object.values(users).sort((a, b) => b.balance - a.balance);
        io.emit('gameEnded', { ranking: sorted.slice(0, 4) });
    });

    socket.on('resetGame', () => {
        if (!users[socket.id]?.isStaff) return;
        Object.values(users).forEach(u => { u.balance = 100000; u.isBeggar = false; });
        gameState = { phase: 'lobby', data: null, bets: {}, selections: {}, timer: 0 };
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
        broadcastUsers();
        io.emit('gameReset');
    });

    socket.on('disconnect', () => {
        // 새로고침으로 대체된 소켓이면 무시 (새 joinGame이 이미 처리함)
        if (socket._replaced) return;
        // 이미 다른 소켓으로 대체된 유저인지 확인
        if (users[socket.id]) {
            delete users[socket.id];
            broadcastUsers();
        }
    });
});

const PORT = process.env.PORT || 3000;
const io = new Server(server, {
    cors: {
        origin: ["https://lucky-island-client-taupe.vercel.app", "http://localhost:5173"],
        methods: ["GET", "POST"]
    }
});
