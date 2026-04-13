const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ───
const MAX_EVENTS_PER_SEC = 15;
const MAX_NAME_LENGTH = 16;
const MAX_AMOUNT = 99999;
const GAME_EXPIRY_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── Game State ───
const games = new Map();

const PLAYER_COLORS = ['#7c6cf0', '#00d4c8', '#ff6b6b', '#00c9a7', '#ffd166', '#fd79a8'];
const PLAYER_EMOJIS = ['🎩', '🚗', '🐕', '👢', '🚢', '🎲'];

const TRANSACTION_REASONS = [
    'Rent Payment',
    'Property Purchase',
    'House Purchase',
    'Hotel Purchase',
    'Income Tax',
    'Luxury Tax',
    'Chance Card',
    'Community Chest',
    'Passing GO',
    'Jail Fine',
    'Mortgage',
    'Unmortgage',
    'Trade Deal',
    'Utility Bill',
    'Railroad Fee',
    'Birthday Gift',
    'Bank Error (in your favor)',
    'Street Repairs',
    'School Tax',
    'Other'
];

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function createGame(hostSocketId, hostName, startMoney) {
    let code;
    do { code = generateCode(); } while (games.has(code));

    // Generate a persistent player ID (not tied to socket)
    const hostPid = 'p_' + Date.now() + '_0';

    const game = {
        code,
        hostPid,
        startMoney: startMoney || 1500,
        state: 'lobby', // lobby | voting | playing | ended
        players: new Map(),
        bankerId: null,
        votes: new Map(),     // voterId(pid) -> candidateId(pid)
        transactions: [],
        socketMap: new Map(), // socketId -> pid
        pidSocketMap: new Map(), // pid -> socketId
        lastUndone: null,     // last undone transaction data (for undo feature)
        createdAt: Date.now() // for game expiry
    };

    game.players.set(hostPid, {
        id: hostPid,
        name: hostName,
        balance: 0,
        color: PLAYER_COLORS[0],
        emoji: PLAYER_EMOJIS[0],
        index: 0,
        connected: true,
        bankrupt: false
    });

    game.socketMap.set(hostSocketId, hostPid);
    game.pidSocketMap.set(hostPid, hostSocketId);

    games.set(code, game);
    return { game, pid: hostPid };
}

function getGameBySocket(socketId) {
    for (const [_, game] of games) {
        if (game.socketMap.has(socketId)) return game;
    }
    return null;
}

function getPid(game, socketId) {
    return game.socketMap.get(socketId);
}

function getSocketId(game, pid) {
    return game.pidSocketMap.get(pid);
}

function serializeGame(game) {
    return {
        code: game.code,
        state: game.state,
        hostPid: game.hostPid,
        bankerId: game.bankerId,
        startMoney: game.startMoney,
        players: Array.from(game.players.values()).filter(p => !p.bankrupt),
        allPlayers: Array.from(game.players.values()),
        votes: Array.from(game.votes.entries()),
        transactions: game.transactions.slice(-50),
        winnerId: game.winnerId || null,
        winnerName: game.winnerName || null
    };
}

// Helper: check if only 1 player remains (winner detection)
function checkWinner(game) {
    if (game.state !== 'playing') return;
    const alive = Array.from(game.players.values()).filter(p => !p.bankrupt);
    if (alive.length === 1) {
        const winner = alive[0];
        game.state = 'ended';
        game.winnerId = winner.id;
        game.winnerName = winner.name;

        // Calculate stats for all players
        const stats = Array.from(game.players.values()).map(p => {
            let totalEarned = 0, totalSpent = 0;
            game.transactions.forEach(tx => {
                if (tx.type === 'system') return;
                if (tx.toId === p.id) totalEarned += (tx.amount || 0);
                if (tx.fromId === p.id) totalSpent += (tx.amount || 0);
            });
            return { id: p.id, name: p.name, emoji: p.emoji, balance: p.balance, totalEarned, totalSpent, bankrupt: p.bankrupt };
        });

        game.transactions.push({
            id: Date.now(),
            type: 'system',
            message: `🏆 ${winner.emoji} ${winner.name} WINS THE GAME!`,
            timestamp: new Date().toISOString()
        });

        io.to(game.code).emit('game-won', {
            winnerId: winner.id,
            winnerName: winner.name,
            winnerEmoji: winner.emoji,
            winnerBalance: winner.balance,
            stats
        });
    }
}

// Helper: sanitize player name
function sanitizeName(name) {
    if (!name || typeof name !== 'string') return '';
    return name.trim().slice(0, MAX_NAME_LENGTH).replace(/[<>]/g, '');
}

// Helper: validate amount
function validateAmount(amount) {
    const amt = parseInt(amount);
    if (isNaN(amt) || amt <= 0 || amt > MAX_AMOUNT) return null;
    return amt;
}

function findAvailableSlot(game) {
    const usedIndices = new Set(Array.from(game.players.values()).map(p => p.index));
    for (let i = 0; i < 6; i++) {
        if (!usedIndices.has(i)) return i;
    }
    return -1;
}

// Helper: check if voting should auto-complete (called after leave/disconnect during voting)
function checkVoteCompletion(game) {
    if (game.state !== 'voting') return;
    const activePlayers = Array.from(game.players.values()).filter(p => !p.bankrupt && p.connected);
    if (activePlayers.length === 0) return;
    if (game.votes.size >= activePlayers.length) {
        const tally = {};
        for (const [_, candidate] of game.votes) {
            // Only count votes for players still in the game
            if (game.players.has(candidate) && !game.players.get(candidate).bankrupt) {
                tally[candidate] = (tally[candidate] || 0) + 1;
            }
        }
        let maxVotes = 0, winnerId = null;
        for (const [id, count] of Object.entries(tally)) {
            if (count > maxVotes) { maxVotes = count; winnerId = id; }
        }
        // Fallback: if no valid votes, pick first active player
        if (!winnerId) winnerId = activePlayers[0].id;

        game.bankerId = winnerId;
        game.state = 'playing';

        for (const [_, player] of game.players) {
            if (!player.bankrupt) player.balance = game.startMoney;
        }

        const winnerName = game.players.get(winnerId).name;
        game.transactions.push({
            id: Date.now(),
            type: 'system',
            message: `🏦 ${winnerName} was elected as Banker!`,
            timestamp: new Date().toISOString()
        });
        game.transactions.push({
            id: Date.now() + 1,
            type: 'system',
            message: `💰 Each player received ৳${game.startMoney}`,
            timestamp: new Date().toISOString()
        });
    }
}

// Helper: transfer host to next connected player
function transferHost(game, leavingPid) {
    if (game.hostPid !== leavingPid) return;
    const remaining = Array.from(game.players.values()).filter(p => p.id !== leavingPid && !p.bankrupt && p.connected);
    if (remaining.length > 0) {
        game.hostPid = remaining[0].id;
        game.transactions.push({
            id: Date.now() + 2,
            type: 'system',
            message: `👑 ${remaining[0].name} is now the Host`,
            timestamp: new Date().toISOString()
        });
    }
}

// ─── Rate Limiting ───
const socketEventCounts = new Map();
setInterval(() => socketEventCounts.clear(), 1000);

function rateLimited(socketId) {
    const count = (socketEventCounts.get(socketId) || 0) + 1;
    socketEventCounts.set(socketId, count);
    return count > MAX_EVENTS_PER_SEC;
}

// ─── Game Expiry (cleanup old games every 10 min) ───
setInterval(() => {
    const now = Date.now();
    for (const [code, game] of games) {
        if (now - game.createdAt > GAME_EXPIRY_MS) {
            games.delete(code);
            console.log(`🕐 Game ${code} expired after 6 hours`);
        }
    }
}, 10 * 60 * 1000);

// ─── Socket Events ───
io.on('connection', (socket) => {
    console.log(`✅ Connected: ${socket.id}`);

    // Rate limit middleware for all events
    socket.use((packet, next) => {
        if (rateLimited(socket.id)) {
            return next(new Error('Rate limited'));
        }
        next();
    });

    // ─── Rejoin (session restore after reload) ───
    socket.on('rejoin', ({ code, playerName }, cb) => {
        const game = games.get(code);
        if (!game) return cb({ success: false, error: 'Game not found' });

        // Find player by name
        let foundPid = null;
        for (const [pid, p] of game.players) {
            if (p.name === playerName && !p.bankrupt) {
                foundPid = pid;
                break;
            }
        }

        if (!foundPid) return cb({ success: false, error: 'Player not found in game' });

        // Unmap old socket if any
        const oldSocket = game.pidSocketMap.get(foundPid);
        if (oldSocket) game.socketMap.delete(oldSocket);

        // Map new socket
        game.socketMap.set(socket.id, foundPid);
        game.pidSocketMap.set(foundPid, socket.id);
        game.players.get(foundPid).connected = true;

        socket.join(code);
        io.to(code).emit('game-update', serializeGame(game));
        cb({ success: true, game: serializeGame(game), playerId: foundPid });
        console.log(`🔄 ${playerName} rejoined game ${code}`);
    });

    socket.on('create-game', ({ name, startMoney }, cb) => {
        const safeName = sanitizeName(name);
        if (!safeName) return cb({ success: false, error: 'Invalid name' });
        const { game, pid } = createGame(socket.id, safeName, startMoney);
        socket.join(game.code);
        cb({ success: true, game: serializeGame(game), playerId: pid });
        console.log(`🎮 Game ${game.code} created by ${safeName}`);
    });

    socket.on('join-game', ({ code, name }, cb) => {
        const safeName = sanitizeName(name);
        if (!safeName) return cb({ success: false, error: 'Invalid name' });
        const game = games.get(code);
        if (!game) return cb({ success: false, error: 'Game not found. Check your code.' });

        // Check if name already exists (and connected) - prevent duplicates
        for (const [_, p] of game.players) {
            if (p.name === safeName && p.connected && !p.bankrupt) {
                return cb({ success: false, error: 'A player with that name is already in the game.' });
            }
        }

        const activeCount = Array.from(game.players.values()).filter(p => !p.bankrupt).length;
        if (activeCount >= 6) return cb({ success: false, error: 'Game is full (6 players max).' });

        const idx = findAvailableSlot(game);
        if (idx === -1) return cb({ success: false, error: 'No slots available.' });

        const pid = 'p_' + Date.now() + '_' + idx;

        const player = {
            id: pid,
            name: safeName,
            balance: game.state === 'playing' ? game.startMoney : 0,
            color: PLAYER_COLORS[idx],
            emoji: PLAYER_EMOJIS[idx],
            index: idx,
            connected: true,
            bankrupt: false
        };

        game.players.set(pid, player);
        game.socketMap.set(socket.id, pid);
        game.pidSocketMap.set(pid, socket.id);

        socket.join(code);

        if (game.state === 'playing') {
            game.transactions.push({
                id: Date.now(),
                type: 'system',
                message: `${player.emoji} ${safeName} joined the game with ৳${game.startMoney}`,
                timestamp: new Date().toISOString()
            });
        }

        // Notify other players
        socket.to(code).emit('player-joined', { name: player.name, emoji: player.emoji });

        io.to(code).emit('game-update', serializeGame(game));
        cb({ success: true, game: serializeGame(game), playerId: pid });
        console.log(`👤 ${safeName} joined game ${code}${game.state === 'playing' ? ' (mid-game)' : ''}`);
    });

    socket.on('start-voting', (_, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game) return cb?.({ success: false, error: 'No game found' });
        const pid = getPid(game, socket.id);
        if (pid !== game.hostPid) return cb?.({ success: false, error: 'Only host can start voting' });

        const activeCount = Array.from(game.players.values()).filter(p => !p.bankrupt).length;
        if (activeCount < 2) return cb?.({ success: false, error: 'Need at least 2 players' });

        game.state = 'voting';
        game.votes.clear();
        io.to(game.code).emit('game-update', serializeGame(game));
        cb?.({ success: true });
    });

    socket.on('vote-banker', ({ candidateId }, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game || game.state !== 'voting') return cb?.({ success: false });
        const pid = getPid(game, socket.id);

        game.votes.set(pid, candidateId);
        checkVoteCompletion(game);

        io.to(game.code).emit('game-update', serializeGame(game));
        cb?.({ success: true });
    });

    socket.on('transfer', ({ toIds, amount, reason }, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game || game.state !== 'playing') return cb?.({ success: false, error: 'Game not active' });

        const pid = getPid(game, socket.id);
        const sender = game.players.get(pid);
        if (!sender) return cb?.({ success: false, error: 'Player not found' });
        if (sender.bankrupt) return cb?.({ success: false, error: 'You are bankrupt' });

        const targets = Array.isArray(toIds) ? toIds : [toIds];
        const amt = validateAmount(amount);
        if (!amt) return cb?.({ success: false, error: 'Invalid amount (max ৳99,999)' });

        // Validate all receivers
        const receivers = [];
        for (const tid of targets) {
            const r = game.players.get(tid);
            if (r && !r.bankrupt) receivers.push(r);
        }

        if (receivers.length === 0) return cb?.({ success: false, error: 'No valid receivers selected' });

        const totalNeeded = amt * receivers.length;
        if (sender.balance < totalNeeded) {
            return cb?.({ success: false, error: 'insufficient', needed: totalNeeded, have: sender.balance });
        }

        // Execute transfers
        sender.balance -= totalNeeded;

        receivers.forEach(receiver => {
            receiver.balance += amt;

            const tx = {
                id: Date.now() + Math.random(),
                type: 'transfer',
                fromId: pid,
                fromName: sender.name,
                fromEmoji: sender.emoji,
                toId: receiver.id,
                toName: receiver.name,
                toEmoji: receiver.emoji,
                amount: amt,
                reason: reason || 'Transfer',
                timestamp: new Date().toISOString()
            };
            game.transactions.push(tx);

            const toSocket = getSocketId(game, receiver.id);
            if (toSocket) io.to(toSocket).emit('money-received', { from: sender.name, amount: amt, reason });
        });

        io.to(socket.id).emit('money-sent', { to: receivers.map(r => r.name).join(', '), amount: totalNeeded, reason });
        io.to(game.code).emit('game-update', serializeGame(game));
        cb?.({ success: true });
    });

    socket.on('bank-give', ({ toIds, amount, reason }, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game || game.state !== 'playing') return cb?.({ success: false, error: 'Game not active' });
        const pid = getPid(game, socket.id);
        if (pid !== game.bankerId) return cb?.({ success: false, error: 'Only banker can do this' });

        const targets = Array.isArray(toIds) ? toIds : [toIds];
        const amt = validateAmount(amount);
        if (!amt) return cb?.({ success: false, error: 'Invalid amount (max ৳99,999)' });

        const receivers = [];
        for (const tid of targets) {
            const r = game.players.get(tid);
            if (r && !r.bankrupt) receivers.push(r);
        }

        if (receivers.length === 0) return cb?.({ success: false, error: 'No valid receivers selected' });

        receivers.forEach(receiver => {
            receiver.balance += amt;

            game.transactions.push({
                id: Date.now() + Math.random(),
                type: 'bank-give',
                fromName: '🏦 Bank',
                toId: receiver.id,
                toName: receiver.name,
                toEmoji: receiver.emoji,
                amount: amt,
                reason: reason || 'Bank Payment',
                timestamp: new Date().toISOString()
            });

            const toSocket = getSocketId(game, receiver.id);
            if (toSocket) io.to(toSocket).emit('money-received', { from: '🏦 Bank', amount: amt, reason });
        });

        io.to(game.code).emit('game-update', serializeGame(game));
        cb?.({ success: true });
    });

    socket.on('bank-take', ({ fromIds, amount, reason }, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game || game.state !== 'playing') return cb?.({ success: false, error: 'Game not active' });
        const pid = getPid(game, socket.id);
        if (pid !== game.bankerId) return cb?.({ success: false, error: 'Only banker can do this' });

        const targets = Array.isArray(fromIds) ? fromIds : [fromIds];
        const amt = validateAmount(amount);
        if (!amt) return cb?.({ success: false, error: 'Invalid amount (max ৳99,999)' });

        const payers = [];
        for (const fid of targets) {
            const p = game.players.get(fid);
            if (p && !p.bankrupt) payers.push(p);
        }

        if (payers.length === 0) return cb?.({ success: false, error: 'No valid payers selected' });

        // Check if any payer can't afford it
        // If one fails, SHOULD we fail all? Or collect from those who can?
        // User said "same works with the bank collect money bank can collect money from multiple player"
        // Let's try to collect from all. If any fail, we report them but continue others.

        const failed = [];
        const success = [];

        payers.forEach(payer => {
            if (payer.balance < amt) {
                failed.push(payer);
                const targetSocket = getSocketId(game, payer.id);
                if (targetSocket) {
                    io.to(targetSocket).emit('bankrupt-check', {
                        needed: amt,
                        have: payer.balance,
                        reason: reason || 'Bank Collection'
                    });
                }
            } else {
                payer.balance -= amt;
                success.push(payer);

                game.transactions.push({
                    id: Date.now() + Math.random(),
                    type: 'bank-take',
                    fromId: payer.id,
                    fromName: payer.name,
                    fromEmoji: payer.emoji,
                    toName: '🏦 Bank',
                    amount: amt,
                    reason: reason || 'Bank Collection',
                    timestamp: new Date().toISOString()
                });

                const fromSocket = getSocketId(game, payer.id);
                if (fromSocket) io.to(fromSocket).emit('money-sent', { to: '🏦 Bank', amount: amt, reason });
            }
        });

        io.to(game.code).emit('game-update', serializeGame(game));

        if (failed.length > 0) {
            return cb?.({
                success: success.length > 0,
                error: 'insufficient-remote',
                failedNames: failed.map(p => p.name).join(', '),
                partialSuccess: success.length > 0
            });
        }

        cb?.({ success: true });
    });

    socket.on('pay-bank', ({ amount, reason }, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game || game.state !== 'playing') return cb?.({ success: false, error: 'Game not active' });

        const pid = getPid(game, socket.id);
        const player = game.players.get(pid);
        const amt = validateAmount(amount);
        if (!amt) return cb?.({ success: false, error: 'Invalid amount (max ৳99,999)' });
        if (player.bankrupt) return cb?.({ success: false, error: 'You are bankrupt' });

        if (player.balance < amt) {
            return cb?.({ success: false, error: 'insufficient', needed: amt, have: player.balance });
        }

        player.balance -= amt;

        game.transactions.push({
            id: Date.now(),
            type: 'pay-bank',
            fromId: pid,
            fromName: player.name,
            fromEmoji: player.emoji,
            toName: '🏦 Bank',
            amount: amt,
            reason: reason || 'Payment to Bank',
            timestamp: new Date().toISOString()
        });

        io.to(game.code).emit('game-update', serializeGame(game));
        cb?.({ success: true });
    });

    socket.on('go-bankrupt', (_, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game || game.state !== 'playing') return cb?.({ success: false });
        const pid = getPid(game, socket.id);
        const player = game.players.get(pid);
        if (!player) return cb?.({ success: false });

        player.bankrupt = true;
        player.connected = false;
        player.balance = 0;

        game.transactions.push({
            id: Date.now(),
            type: 'system',
            message: `💀 ${player.emoji} ${player.name} went BANKRUPT!`,
            timestamp: new Date().toISOString()
        });

        // Notify all players
        io.to(game.code).emit('player-bankrupt', { name: player.name, emoji: player.emoji });

        // If banker goes bankrupt, assign to host or next player
        if (pid === game.bankerId) {
            const remaining = Array.from(game.players.values()).filter(p => !p.bankrupt);
            if (remaining.length > 0) {
                game.bankerId = remaining[0].id;
                game.transactions.push({
                    id: Date.now() + 1,
                    type: 'system',
                    message: `🏦 ${remaining[0].name} is now the Banker`,
                    timestamp: new Date().toISOString()
                });
            }
        }

        // Clean session
        game.socketMap.delete(socket.id);
        game.pidSocketMap.delete(pid);
        socket.leave(game.code);

        io.to(game.code).emit('game-update', serializeGame(game));
        checkWinner(game);
        cb?.({ success: true });
    });

    socket.on('leave-game', (_, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game) return cb?.({ success: false });
        const pid = getPid(game, socket.id);
        const player = game.players.get(pid);
        if (!player) return cb?.({ success: false });

        if (game.state === 'playing') {
            // In-game leave = bankrupt
            player.bankrupt = true;
            player.balance = 0;
            game.transactions.push({
                id: Date.now(),
                type: 'system',
                message: `🚪 ${player.emoji} ${player.name} left the game`,
                timestamp: new Date().toISOString()
            });

            // Notify others
            io.to(game.code).emit('player-bankrupt', { name: player.name, emoji: player.emoji });

            if (pid === game.bankerId) {
                const remaining = Array.from(game.players.values()).filter(p => !p.bankrupt);
                if (remaining.length > 0) {
                    game.bankerId = remaining[0].id;
                    game.transactions.push({
                        id: Date.now() + 1,
                        type: 'system',
                        message: `🏦 ${remaining[0].name} is now the Banker`,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        } else if (game.state === 'voting') {
            // Remove player and their vote during voting
            game.players.delete(pid);
            game.votes.delete(pid);
            // Remove any votes FOR this player
            for (const [voterId, candidateId] of game.votes) {
                if (candidateId === pid) game.votes.delete(voterId);
            }
            // Transfer host if needed
            transferHost(game, pid);
            // Check if voting should auto-complete
            checkVoteCompletion(game);
        } else {
            // In lobby, just remove
            game.players.delete(pid);
            game.votes.delete(pid);
            // Transfer host if needed
            transferHost(game, pid);
        }

        game.socketMap.delete(socket.id);
        game.pidSocketMap.delete(pid);
        player.connected = false;
        socket.leave(game.code);

        io.to(game.code).emit('game-update', serializeGame(game));
        checkWinner(game);
        cb?.({ success: true });

        // Clean up empty games
        const remaining = Array.from(game.players.values()).filter(p => !p.bankrupt && p.connected);
        if (remaining.length === 0) {
            games.delete(game.code);
            console.log(`🗑️ Game ${game.code} removed`);
        }
    });

    socket.on('update-start-money', ({ amount }, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game) return cb?.({ success: false });
        const pid = getPid(game, socket.id);
        if (pid !== game.hostPid) return cb?.({ success: false });
        if (game.state !== 'lobby') return cb?.({ success: false });
        game.startMoney = parseInt(amount) || 1500;
        io.to(game.code).emit('game-update', serializeGame(game));
        cb?.({ success: true });
    });

    // ─── GO Money Request (যাত্রা শুরু) ───
    socket.on('request-go-money', (_, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game || game.state !== 'playing') return cb?.({ success: false, error: 'Game not active' });

        const pid = getPid(game, socket.id);
        const player = game.players.get(pid);
        if (!player || player.bankrupt) return cb?.({ success: false, error: 'Invalid player' });

        if (!game.bankerId) return cb?.({ success: false, error: 'No banker assigned' });

        // If the requester IS the banker, auto-approve
        if (pid === game.bankerId) {
            player.balance += 1000;
            game.transactions.push({
                id: Date.now(),
                type: 'bank-give',
                fromName: '🏦 Bank',
                toId: pid,
                toName: player.name,
                toEmoji: player.emoji,
                amount: 1000,
                reason: 'যাত্রা শুরু (Passing GO)',
                timestamp: new Date().toISOString()
            });
            io.to(game.code).emit('game-update', serializeGame(game));
            return cb?.({ success: true, autoApproved: true });
        }

        const bankerSocket = getSocketId(game, game.bankerId);
        if (!bankerSocket) return cb?.({ success: false, error: 'Banker is not connected' });

        // Send request to banker
        io.to(bankerSocket).emit('go-money-request', {
            requestId: Date.now().toString(),
            playerId: pid,
            playerName: player.name,
            playerEmoji: player.emoji,
            amount: 1000
        });

        cb?.({ success: true });
    });

    socket.on('respond-go-request', ({ playerId, accepted }, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game || game.state !== 'playing') return cb?.({ success: false });

        const pid = getPid(game, socket.id);
        if (pid !== game.bankerId) return cb?.({ success: false, error: 'Only banker can respond' });

        const player = game.players.get(playerId);
        if (!player || player.bankrupt) return cb?.({ success: false, error: 'Player not found' });

        if (accepted) {
            player.balance += 1000;

            game.transactions.push({
                id: Date.now(),
                type: 'bank-give',
                fromName: '🏦 Bank',
                toId: playerId,
                toName: player.name,
                toEmoji: player.emoji,
                amount: 1000,
                reason: 'যাত্রা শুরু (Passing GO)',
                timestamp: new Date().toISOString()
            });

            const playerSocket = getSocketId(game, playerId);
            if (playerSocket) {
                io.to(playerSocket).emit('go-money-result', { accepted: true, amount: 1000 });
                io.to(playerSocket).emit('money-received', { from: '🏦 Bank', amount: 1000, reason: 'যাত্রা শুরু' });
            }

            io.to(game.code).emit('game-update', serializeGame(game));
        } else {
            const playerSocket = getSocketId(game, playerId);
            if (playerSocket) {
                io.to(playerSocket).emit('go-money-result', { accepted: false });
            }
        }

        cb?.({ success: true });
    });

    // ─── Undo Last Transaction (Banker only) ───
    socket.on('undo-transaction', (_, cb) => {
        const game = getGameBySocket(socket.id);
        if (!game || game.state !== 'playing') return cb?.({ success: false, error: 'Game not active' });
        const pid = getPid(game, socket.id);
        if (pid !== game.bankerId) return cb?.({ success: false, error: 'Only banker can undo' });

        // Find the last non-system transaction
        let lastTx = null;
        let lastIdx = -1;
        for (let i = game.transactions.length - 1; i >= 0; i--) {
            if (game.transactions[i].type !== 'system') {
                lastTx = game.transactions[i];
                lastIdx = i;
                break;
            }
        }

        if (!lastTx) return cb?.({ success: false, error: 'No transaction to undo' });

        // Reverse the transaction
        const amt = lastTx.amount || 0;

        if (lastTx.type === 'transfer') {
            const from = game.players.get(lastTx.fromId);
            const to = game.players.get(lastTx.toId);
            if (from && !from.bankrupt) from.balance += amt;
            if (to && !to.bankrupt) to.balance -= amt;
        } else if (lastTx.type === 'bank-give') {
            const to = game.players.get(lastTx.toId);
            if (to && !to.bankrupt) to.balance -= amt;
        } else if (lastTx.type === 'bank-take' || lastTx.type === 'pay-bank') {
            const from = game.players.get(lastTx.fromId);
            if (from && !from.bankrupt) from.balance += amt;
        }

        // Remove the transaction and add undo record
        game.transactions.splice(lastIdx, 1);
        game.transactions.push({
            id: Date.now(),
            type: 'system',
            message: `↩️ Banker undid: ${lastTx.fromName || '🏦 Bank'} → ${lastTx.toName || '🏦 Bank'} ৳${amt}`,
            timestamp: new Date().toISOString()
        });

        io.to(game.code).emit('game-update', serializeGame(game));
        io.to(game.code).emit('transaction-undone', {
            message: `↩️ Banker undid the last transaction (৳${amt})`
        });
        cb?.({ success: true });
    });

    socket.on('disconnect', () => {
        const game = getGameBySocket(socket.id);
        if (game) {
            const pid = getPid(game, socket.id);
            const player = pid ? game.players.get(pid) : null;
            if (player) {
                player.connected = false;

                // If disconnected during voting, check if vote should auto-complete
                if (game.state === 'voting') {
                    checkVoteCompletion(game);
                }

                io.to(game.code).emit('game-update', serializeGame(game));
                console.log(`❌ ${player.name} disconnected from game ${game.code}`);
            }

            // Don't delete socket mappings - needed for rejoin
            // Clean up empty games after timeout
            setTimeout(() => {
                if (!game.players) return;
                const connected = Array.from(game.players.values()).filter(p => p.connected && !p.bankrupt);
                if (connected.length === 0) {
                    games.delete(game.code);
                    console.log(`🗑️ Game ${game.code} removed (all disconnected)`);
                }
            }, 60000); // 1 minute grace period
        }
    });

    socket.on('get-reasons', (_, cb) => {
        cb?.(TRANSACTION_REASONS);
    });
});

// ─── Start Server ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║       💰 MONOPOLY MONEY SERVER 💰        ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Port:     ${PORT}                            ║`);
    console.log(`║  Local:    http://localhost:${PORT}          ║`);

    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                const url = `http://${iface.address}:${PORT}`;
                console.log(`║  Network:  ${url.padEnd(29)}║`);
            }
        }
    }

    console.log('╠══════════════════════════════════════════╣');
    console.log('║  Share the Network URL with players!     ║');
    console.log('╚══════════════════════════════════════════╝\n');
});
