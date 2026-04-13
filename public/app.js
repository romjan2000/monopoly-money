/* ═══════════════════════════════════════════
   MONOPOLY MONEY — Client Application
   ═══════════════════════════════════════════ */

const socket = io();

// ─── State ───
let myId = null;
let gameState = null;
let currentMode = 'player';
let transactionReasons = [];
let modalType = null;       // 'send' | 'pay-bank' | 'bank-give' | 'bank-take'
let selectedPlayerId = null;
let selectedReason = '';
let historyOpen = false;
let seenTxCount = 0;

// ─── Helpers ───
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function formatMoney(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function vibrate() {
    if (navigator.vibrate) navigator.vibrate(100);
}

function saveSession(code, name, playerId) {
    localStorage.setItem('mm_code', code);
    localStorage.setItem('mm_name', name);
    localStorage.setItem('mm_pid', playerId);
}

function clearSession() {
    localStorage.removeItem('mm_code');
    localStorage.removeItem('mm_name');
    localStorage.removeItem('mm_pid');
}

function getSavedSession() {
    const code = localStorage.getItem('mm_code');
    const name = localStorage.getItem('mm_name');
    const pid = localStorage.getItem('mm_pid');
    if (code && name) return { code, name, pid };
    return null;
}

// ─── Screens ───
const screens = {
    splash: $('#screen-splash'),
    create: $('#screen-create'),
    join: $('#screen-join'),
    lobby: $('#screen-lobby'),
    voting: $('#screen-voting'),
    game: $('#screen-game')
};

function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
}

// ─── Auto-Rejoin on Page Load ───
socket.on('connect', () => {
    const session = getSavedSession();
    if (session) {
        socket.emit('rejoin', { code: session.code, playerName: session.name }, (res) => {
            if (res.success) {
                myId = res.playerId;
                gameState = res.game;
                if (gameState.state === 'lobby') { showScreen('lobby'); renderLobby(); }
                else if (gameState.state === 'voting') { showScreen('voting'); renderVoting(); }
                else if (gameState.state === 'playing') { showScreen('game'); seenTxCount = gameState.transactions.length; renderGame(null); }
                showToast('Reconnected! ✅', 'success');
            } else {
                clearSession();
            }
        });
    }
});

// ─── Splash Buttons ───
$('#btn-create').addEventListener('click', () => showScreen('create'));
$('#btn-join').addEventListener('click', () => showScreen('join'));
$('#btn-back-create').addEventListener('click', () => showScreen('splash'));
$('#btn-back-join').addEventListener('click', () => showScreen('splash'));

// ─── Money Selector ───
$$('.money-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        $$('.money-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $('#input-start-money').value = btn.dataset.amount;
    });
});

$('#input-start-money').addEventListener('input', () => {
    $$('.money-btn').forEach(b => b.classList.remove('active'));
});

// ─── Code Input ───
const codeInputs = [$('#input-code-1'), $('#input-code-2'), $('#input-code-3'), $('#input-code-4')];
codeInputs.forEach((input, i) => {
    input.addEventListener('input', (e) => {
        // Filter to digits only
        e.target.value = e.target.value.replace(/[^0-9]/g, '');
        if (e.target.value && i < 3) codeInputs[i + 1].focus();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !e.target.value && i > 0) codeInputs[i - 1].focus();
    });
    input.addEventListener('paste', (e) => {
        e.preventDefault();
        const paste = (e.clipboardData || window.clipboardData).getData('text').trim();
        if (paste.length === 4) {
            codeInputs.forEach((inp, j) => { inp.value = paste[j]; });
            codeInputs[3].focus();
        }
    });
});

// ─── Create Game ───
$('#btn-create-go').addEventListener('click', () => {
    const name = $('#input-host-name').value.trim();
    if (!name) return showToast('Enter your name!', 'error');
    const startMoney = parseInt($('#input-start-money').value) || 1500;
    $('#btn-create-go').disabled = true;
    socket.emit('create-game', { name, startMoney }, (res) => {
        $('#btn-create-go').disabled = false;
        if (res.success) {
            myId = res.playerId;
            gameState = res.game;
            saveSession(res.game.code, name, myId);
            showScreen('lobby');
            renderLobby();
        } else {
            showToast(res.error || 'Failed', 'error');
        }
    });
});

// ─── Join Game ───
$('#btn-join-go').addEventListener('click', () => {
    const name = $('#input-join-name').value.trim();
    if (!name) return showToast('Enter your name!', 'error');
    const code = codeInputs.map(i => i.value).join('');
    if (code.length !== 4) return showToast('Enter the 4-digit code!', 'error');
    $('#btn-join-go').disabled = true;
    socket.emit('join-game', { code, name }, (res) => {
        $('#btn-join-go').disabled = false;
        if (res.success) {
            myId = res.playerId;
            gameState = res.game;
            saveSession(res.game.code, name, myId);
            // If game is already playing, skip lobby
            if (gameState.state === 'playing') {
                showScreen('game');
                seenTxCount = gameState.transactions.length;
                renderGame(null);
                showToast('Joined the game! 🎉', 'success');
            } else {
                showScreen('lobby');
                renderLobby();
            }
        } else {
            showToast(res.error || 'Failed', 'error');
        }
    });
});

// ─── Get Transaction Reasons ───
socket.emit('get-reasons', null, (reasons) => {
    transactionReasons = reasons || [];
});

// ─── Game Update Handler ───
socket.on('game-update', (game) => {
    const prevState = gameState;
    gameState = game;

    if (game.state === 'lobby') {
        showScreen('lobby');
        renderLobby();
    } else if (game.state === 'voting') {
        if (!screens.voting.classList.contains('active')) showScreen('voting');
        renderVoting();
    } else if (game.state === 'playing') {
        if (!screens.game.classList.contains('active')) {
            showScreen('game');
            seenTxCount = game.transactions.length;
        }
        // Detect if I just became the new banker (auto-assigned)
        if (prevState && prevState.bankerId !== game.bankerId && game.bankerId === myId) {
            showToast('🏦 You are now the Banker!', 'success');
            vibrate();
            currentMode = 'player'; // Reset to player mode
        }
        renderGame(prevState);
    }
});

// ─── Money Notifications ───
socket.on('money-received', ({ from, amount, reason }) => {
    showToast(`💰 Received ৳${formatMoney(amount)} from ${from}${reason ? ' — ' + reason : ''}`, 'success');
    vibrate();
});

socket.on('money-sent', ({ to, amount, reason }) => {
    showToast(`💸 Sent ৳${formatMoney(amount)} to ${to}${reason ? ' — ' + reason : ''}`, 'info');
});

// ─── Bankrupt Check (sent to TARGET player when bank tries to collect) ───
socket.on('bankrupt-check', ({ needed, have, reason }) => {
    vibrate();
    $('#bankrupt-info').textContent = `🏦 Bank wants to collect ৳${formatMoney(needed)} for "${reason}" but you only have ৳${formatMoney(have)}`;
    $('#btn-bankrupt').classList.remove('hidden');
    $('#btn-think').textContent = '🤔 Let me think';
    $('#bankrupt-overlay').classList.remove('hidden');
});

// ─── Player Joined / Bankrupt Notifications ───
socket.on('player-joined', ({ name, emoji }) => {
    showToast(`${emoji} ${name} joined the game!`, 'info');
    vibrate();
});

socket.on('player-bankrupt', ({ name, emoji }) => {
    showToast(`💀 ${emoji} ${name} went bankrupt!`, 'error');
    vibrate();
});

// ═══ LOBBY ═══
function renderLobby() {
    if (!gameState) return;
    $('#lobby-code').textContent = gameState.code;
    $('#lobby-start-money').textContent = `৳${formatMoney(gameState.startMoney)}`;
    $('#lobby-count').textContent = `${gameState.players.length}/6`;

    const container = $('#lobby-players');
    container.innerHTML = '';

    gameState.players.forEach(p => {
        const div = document.createElement('div');
        div.className = 'lobby-player';
        div.innerHTML = `
      <div class="lobby-player-avatar" style="background: ${p.color}20; border: 2px solid ${p.color}">${p.emoji}</div>
      <span class="lobby-player-name">${escHtml(p.name)}</span>
      ${p.id === gameState.hostPid ? '<span class="lobby-player-tag tag-host">Host</span>' : ''}
      ${p.id === myId ? '<span class="lobby-player-tag tag-you">You</span>' : ''}
    `;
        container.appendChild(div);
    });

    const isHost = myId === gameState.hostPid;
    $('#lobby-host-actions').classList.toggle('hidden', !isHost);
    $('#lobby-waiting').classList.toggle('hidden', isHost);
    $('#btn-start-voting').disabled = gameState.players.length < 2;
}

$('#btn-start-voting').addEventListener('click', () => {
    socket.emit('start-voting', null, (res) => {
        if (!res.success) showToast(res.error, 'error');
    });
});

// ─── Leave Lobby ───
$('#btn-leave-lobby').addEventListener('click', () => {
    socket.emit('leave-game', null, (res) => {
        if (res.success) {
            clearSession();
            gameState = null;
            myId = null;
            showScreen('splash');
            showToast('Left the game', 'info');
        }
    });
});

// ═══ VOTING ═══
let hasVoted = false;
function renderVoting() {
    if (!gameState) return;
    const container = $('#vote-candidates');
    container.innerHTML = '';

    const myVote = gameState.votes.find(([voterId]) => voterId === myId);
    hasVoted = !!myVote;

    gameState.players.forEach(p => {
        const card = document.createElement('div');
        card.className = 'vote-card' + (hasVoted ? ' voted' : '');
        if (myVote && myVote[1] === p.id) card.classList.add('selected');

        card.innerHTML = `
      <div class="vote-avatar" style="background: ${p.color}20; border: 2px solid ${p.color}">${p.emoji}</div>
      <span class="vote-name">${escHtml(p.name)}</span>
      <div class="vote-check">${myVote && myVote[1] === p.id ? '✓' : ''}</div>
    `;

        if (!hasVoted) {
            card.addEventListener('click', () => {
                socket.emit('vote-banker', { candidateId: p.id }, (res) => {
                    if (!res.success) showToast('Vote failed', 'error');
                });
            });
        }

        container.appendChild(card);
    });

    const votedCount = gameState.votes.length;
    const totalCount = gameState.players.length;
    $('#vote-status').innerHTML = hasVoted
        ? `<div class="pulse-dot"></div><p>Votes: ${votedCount}/${totalCount} — Waiting for others...</p>`
        : `<p>Tap a player to vote</p>`;
}

// ═══ GAME ═══
function renderGame(prevState) {
    if (!gameState) return;
    renderBalanceGrid(prevState);
    renderMyWallet();
    renderModeToggle();
    renderActions();
    updateHistoryBadge();
    if (historyOpen) renderHistory();
}

function renderBalanceGrid(prevState) {
    const grid = $('#balance-grid');

    // Optimization: Don't destroy/recreate grid if players count matches, just update
    // But for simplicity/correctness with "diffs", we can selectively update or just re-render carefully.
    // To support the diff animation properly, we need to KNOW the previous balance for that specific card.

    // If exact same number of players, try to update in place to preserve animations? 
    // Actually, simply re-rendering is fine IF we trigger the animation immediately.

    grid.innerHTML = '';

    gameState.players.forEach(p => {
        const card = document.createElement('div');
        card.className = 'balance-card';
        if (p.id === myId) card.classList.add('is-me');
        if (p.id === gameState.bankerId) card.classList.add('is-banker');
        if (!p.connected) card.classList.add('disconnected');

        // Initial render value
        let startBalance = p.balance;
        let animate = false;

        if (prevState) {
            const prev = prevState.players.find(pp => pp.id === p.id);
            if (prev && prev.balance !== p.balance) {
                startBalance = prev.balance; // Start counter from OLD balance
                animate = true;
            }
        }

        card.innerHTML = `
      <div class="balance-avatar">${p.emoji}</div>
      <div class="balance-name">${escHtml(p.name)}</div>
      <div class="balance-amount">৳${formatMoney(startBalance)}</div>
    `;

        grid.appendChild(card);

        if (animate) {
            animateBalance(card, startBalance, p.balance);
        }
    });
}

let myPrevBalance = null; // State to track my own balance for animation. Null = not initialized.

function renderMyWallet() {
    const me = gameState.players.find(p => p.id === myId);
    if (!me) return;

    // Always update name
    $('#my-name').textContent = me.name + (myId === gameState.bankerId ? ' 🏦 Banker' : '');

    const balanceElem = $('#my-balance');
    const walletContainer = document.querySelector('.my-wallet');

    // Initialize or Reset
    if (myPrevBalance === null) {
        balanceElem.textContent = `৳${formatMoney(me.balance)}`;
        myPrevBalance = me.balance;
        return;
    }

    // If balance changed, animate
    if (me.balance !== myPrevBalance) {
        animateBalance(walletContainer, myPrevBalance, me.balance, true);
        myPrevBalance = me.balance;
    }
}


function renderModeToggle() {
    $('#mode-toggle').classList.toggle('hidden', myId !== gameState.bankerId);
}

function renderActions() {
    const isBanker = myId === gameState.bankerId;
    if (currentMode === 'bank' && isBanker) {
        $('#player-actions').classList.add('hidden');
        $('#bank-actions').classList.remove('hidden');
    } else {
        $('#player-actions').classList.remove('hidden');
        $('#bank-actions').classList.add('hidden');
    }
}

// ─── Mode Toggle ───
$('#mode-player-btn').addEventListener('click', () => {
    currentMode = 'player';
    $('#mode-player-btn').classList.add('active');
    $('#mode-bank-btn').classList.remove('active');
    renderActions();
});

$('#mode-bank-btn').addEventListener('click', () => {
    currentMode = 'bank';
    $('#mode-bank-btn').classList.add('active');
    $('#mode-player-btn').classList.remove('active');
    renderActions();
});

// ─── Action Buttons ───
$('#btn-send-player').addEventListener('click', () => openModal('send'));
$('#btn-pay-bank').addEventListener('click', () => openModal('pay-bank'));
$('#btn-bank-give').addEventListener('click', () => openModal('bank-give'));
$('#btn-bank-take').addEventListener('click', () => openModal('bank-take'));

// ─── Leave Game ───
$('#btn-leave-game').addEventListener('click', () => {
    $('#leave-overlay').classList.remove('hidden');
});

$('#btn-confirm-leave').addEventListener('click', () => {
    socket.emit('leave-game', null, (res) => {
        if (res.success) {
            clearSession();
            gameState = null;
            myId = null;
            $('#leave-overlay').classList.add('hidden');
            showScreen('splash');
            showToast('You left the game', 'info');
        }
    });
});

$('#btn-cancel-leave').addEventListener('click', () => {
    $('#leave-overlay').classList.add('hidden');
});

// ─── History ───
$('#btn-history-toggle').addEventListener('click', () => {
    historyOpen = !historyOpen;
    $('#transaction-history').classList.toggle('hidden', !historyOpen);
    if (historyOpen) {
        seenTxCount = gameState.transactions.length;
        updateHistoryBadge();
        renderHistory();
    }
});

function updateHistoryBadge() {
    if (!gameState) return;
    const unseen = gameState.transactions.length - seenTxCount;
    const badge = $('#history-badge');
    if (unseen > 0 && !historyOpen) {
        badge.textContent = unseen;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function renderHistory() {
    const list = $('#history-list');
    list.innerHTML = '';

    if (gameState.transactions.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📜</div><div class="empty-state-text">No transactions yet</div></div>';
        return;
    }

    [...gameState.transactions].reverse().forEach(tx => {
        if (tx.type === 'system') {
            const div = document.createElement('div');
            div.className = 'tx-system';
            div.textContent = tx.message;
            list.appendChild(div);
            return;
        }

        const div = document.createElement('div');
        div.className = 'tx-item';

        let emoji = '💸';
        let amountClass = 'neutral';
        if (tx.toId === myId) { emoji = '💰'; amountClass = 'positive'; }
        else if (tx.fromId === myId) { emoji = '💸'; amountClass = 'negative'; }

        const time = new Date(tx.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        let message = '';
        if (tx.type === 'transfer') message = `${tx.fromName} → ${tx.toName}`;
        else if (tx.type === 'bank-give') { message = `🏦 Bank → ${tx.toName}`; if (tx.toId === myId) amountClass = 'positive'; }
        else if (tx.type === 'bank-take' || tx.type === 'pay-bank') { message = `${tx.fromName} → 🏦 Bank`; if (tx.fromId === myId) amountClass = 'negative'; }

        div.innerHTML = `
      <span class="tx-emoji">${emoji}</span>
      <div class="tx-details">
        <div class="tx-message">${message}</div>
        ${tx.reason ? `<div class="tx-reason">${escHtml(tx.reason)}</div>` : ''}
      </div>
      <span class="tx-amount ${amountClass}">${amountClass === 'negative' ? '-' : amountClass === 'positive' ? '+' : ''}৳${formatMoney(tx.amount)}</span>
      <span class="tx-time">${time}</span>
    `;
        list.appendChild(div);
    });

    seenTxCount = gameState.transactions.length;
    updateHistoryBadge();
}

// ═══ STREAMLINED TRANSFER MODAL ═══
// Everything on ONE screen: player chips + amount + reason + confirm

function openModal(type) {
    modalType = type;
    selectedPlayerIds = new Set(); // Changed from single ID to Set
    selectedReason = '';

    const titles = {
        'send': '💸 Send to Player(s)',
        'pay-bank': '🏦 Pay Bank',
        'bank-give': '💵 Give from Bank',
        'bank-take': '🏧 Collect from Player(s)'
    };
    $('#modal-title').textContent = titles[type] || 'Transfer';

    // Show/hide player selection (not needed for pay-bank)
    const showPlayers = type !== 'pay-bank';
    $('#modal-section-player').classList.toggle('hidden', !showPlayers);

    if (showPlayers) renderPlayerChips();
    renderReasonChips();

    $('#input-amount').value = '';
    $('#modal-overlay').classList.remove('hidden');

    // Auto-focus amount if no player selection needed
    if (!showPlayers) {
        setTimeout(() => $('#input-amount').focus(), 200);
    }
}

function renderPlayerChips() {
    const container = $('#modal-player-chips');
    container.innerHTML = '';

    const candidates = gameState.players.filter(p => {
        // For 'send' (player to player), cannot send to self.
        // For 'bank-give' or 'bank-take', banker CAN select themselves.
        if (modalType === 'send' && p.id === myId) return false;

        if (p.bankrupt) return false;
        return true;
    });

    candidates.forEach(p => {
        const chip = document.createElement('div');
        chip.className = 'player-chip';
        chip.dataset.pid = p.id;
        chip.innerHTML = `
      <span class="player-chip-emoji">${p.emoji}</span>
      <span class="player-chip-name">${escHtml(p.name)}</span>
      <div class="chip-check">✅</div>
    `;

        chip.addEventListener('click', () => {
            // Toggle selection
            if (selectedPlayerIds.has(p.id)) {
                selectedPlayerIds.delete(p.id);
                chip.classList.remove('selected');
            } else {
                selectedPlayerIds.add(p.id);
                chip.classList.add('selected');
            }

            // Auto-focus amount if at least one selected
            if (selectedPlayerIds.size > 0) {
                setTimeout(() => $('#input-amount').focus(), 100);
            }
        });

        container.appendChild(chip);
    });
}

function renderReasonChips() {
    const list = $('#reason-list');
    list.innerHTML = '';
    selectedReason = '';

    transactionReasons.forEach(reason => {
        const chip = document.createElement('button');
        chip.className = 'reason-chip';
        chip.textContent = reason;

        chip.addEventListener('click', () => {
            if (selectedReason === reason) {
                selectedReason = '';
                chip.classList.remove('selected');
            } else {
                selectedReason = reason;
                $$('.reason-chip').forEach(c => c.classList.remove('selected'));
                chip.classList.add('selected');
            }
        });

        list.appendChild(chip);
    });
}

// Quick amount buttons
$$('.quick-amt').forEach(btn => {
    btn.addEventListener('click', () => {
        $('#input-amount').value = btn.dataset.amount;
    });
});

// Close modal
$('#btn-modal-close').addEventListener('click', () => {
    $('#modal-overlay').classList.add('hidden');
});

$('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) $('#modal-overlay').classList.add('hidden');
});

// ─── Confirm Transaction (single button) ───
$('#btn-confirm-tx').addEventListener('click', () => {
    const amount = parseInt($('#input-amount').value);

    if (!amount || amount <= 0) return showToast('Enter an amount!', 'error');

    if (modalType !== 'pay-bank' && selectedPlayerIds.size === 0) {
        return showToast('Select at least one player!', 'error');
    }

    // Disable button to prevent double-click
    const confirmBtn = $('#btn-confirm-tx');
    confirmBtn.disabled = true;

    const reason = selectedReason;
    const targetIds = Array.from(selectedPlayerIds);

    const handleResult = (res) => {
        confirmBtn.disabled = false;
        handleTxResult(res);
    };

    if (modalType === 'send') {
        socket.emit('transfer', { toIds: targetIds, amount, reason }, handleResult);
    } else if (modalType === 'pay-bank') {
        // Pay bank is strictly ME -> BANK, amount is fixed
        socket.emit('pay-bank', { amount, reason }, handleResult);
    } else if (modalType === 'bank-give') {
        socket.emit('bank-give', { toIds: targetIds, amount, reason }, handleResult);
    } else if (modalType === 'bank-take') {
        socket.emit('bank-take', { fromIds: targetIds, amount, reason }, handleResult);
    }
});

function handleTxResult(res) {
    if (res.success) {
        $('#modal-overlay').classList.add('hidden');
        showToast('Transaction complete! ✅', 'success');
    } else if (res.error === 'insufficient') {
        // Self insufficient (send / pay-bank) — show bankrupt popup on MY screen
        $('#modal-overlay').classList.add('hidden');
        const needed = res.needed || 0;
        const have = res.have || 0;
        $('#bankrupt-info').textContent = `You need ৳${formatMoney(needed)} but only have ৳${formatMoney(have)}`;
        $('#btn-bankrupt').classList.remove('hidden');
        $('#btn-think').textContent = '🤔 Let me think';
        $('#bankrupt-overlay').classList.remove('hidden');
    } else if (res.error === 'insufficient-remote') {
        // Bank-take: target player can't afford — banker sees toast, player gets popup on THEIR phone
        $('#modal-overlay').classList.add('hidden');
        showToast(`⚠️ ${res.playerName} only has ৳${formatMoney(res.have)} — bankrupt popup sent to their phone`, 'error');
    } else {
        showToast(res.error || 'Transaction failed', 'error');
    }
}

// ─── Bankrupt Popup ───
$('#btn-bankrupt').addEventListener('click', () => {
    socket.emit('go-bankrupt', null, (res) => {
        if (res.success) {
            clearSession();
            gameState = null;
            myId = null;
            $('#bankrupt-overlay').classList.add('hidden');
            showScreen('splash');
            showToast('💀 You went bankrupt', 'error');
        }
    });
});

$('#btn-think').addEventListener('click', () => {
    $('#bankrupt-overlay').classList.add('hidden');
});

// ═══ TOAST ═══
function showToast(message, type = 'info') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✅', error: '❌', info: 'ℹ️' };
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ─── ANIMATIONS & EFFECTS ───

// 2. Number Counting Animation & Diff Indicator
function animateBalance(container, start, end, isWallet = false) {
    if (start === end) return;

    // 1. Counter Animation
    // For wallet, container is a parent, we need to find the number element
    // For card, container IS the card
    const amountElem = isWallet
        ? container.querySelector('#my-balance') || container
        : container.querySelector('.balance-amount');

    const duration = 7000; // 7 seconds per request
    const range = end - start;
    let current = start;
    const increment = end > start ? 1 : -1;
    const stepTime = Math.abs(Math.floor(duration / range));

    const minStepTime = 20;
    let stepVal = increment; // Default to moving 1 unit in the correct direction
    let finalStepTime = stepTime;

    if (stepTime < minStepTime) {
        finalStepTime = minStepTime;
        // Calculate larger steps if timing is too tight
        // range is signed (e.g. -500), so stepVal will be signed (e.g. -2)
        stepVal = Math.ceil(Math.abs(range) / (duration / minStepTime)) * increment;
    }

    const timer = setInterval(() => {
        current += stepVal;

        // Terminate if we crossed the target
        if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
            current = end;
            clearInterval(timer);
        }
        amountElem.textContent = '৳' + formatMoney(current);
    }, finalStepTime);

    // 2. Diff Indicator
    const diff = end - start;
    const diffElem = document.createElement('div');
    diffElem.className = `balance-diff ${diff > 0 ? 'diff-pos' : 'diff-neg'}`;
    diffElem.textContent = (diff > 0 ? '+' : '') + '৳' + formatMoney(diff);

    // Position differently for wallet vs card
    if (isWallet) {
        // Force relative positioning on wallet container so absolute diff works
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        diffElem.style.right = '20px';
        diffElem.style.fontSize = '24px';
        diffElem.style.top = '50%';
        diffElem.style.transform = 'translateY(-50%)';
        container.appendChild(diffElem);
    } else {
        container.appendChild(diffElem);
    }

    // Remove after animation (slightly longer than 7s to be safe)
    setTimeout(() => diffElem.remove(), 7500);
}

// ─── Button Ripple Removed per request ───


// 2. Number Counting Animation
function animateValue(obj, start, end, duration) {
    if (start === end) return;
    const range = end - start;
    let current = start;
    const increment = end > start ? 1 : -1;
    const stepTime = Math.abs(Math.floor(duration / range));

    // If step is too fast, jump by larger amounts
    const minStepTime = 20;
    let stepVal = 1;
    let finalStepTime = stepTime;

    if (stepTime < minStepTime) {
        finalStepTime = minStepTime;
        stepVal = Math.ceil(range / (duration / minStepTime));
    }

    const timer = setInterval(() => {
        current += stepVal;
        if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
            current = end;
            clearInterval(timer);
        }
        obj.textContent = '৳' + formatMoney(current);
        obj.classList.add('pop');
        setTimeout(() => obj.classList.remove('pop'), 200);
    }, finalStepTime);
}

// 3. Flying Money Animation
function flyMoney(startElem, endElem, count = 5) {
    if (!startElem || !endElem) return;

    const startRect = startElem.getBoundingClientRect();
    const endRect = endElem.getBoundingClientRect();

    for (let i = 0; i < count; i++) {
        setTimeout(() => {
            const coin = document.createElement('div');
            coin.textContent = '💸';
            coin.className = 'money-particle';
            coin.style.left = `${startRect.left + startRect.width / 2}px`;
            coin.style.top = `${startRect.top + startRect.height / 2}px`;
            document.body.appendChild(coin);

            // Animate
            const duration = 1000;
            const keyframes = [
                { transform: 'translate(0, 0) scale(0.5)', opacity: 1 },
                { transform: `translate(${endRect.left - startRect.left}px, ${endRect.top - startRect.top}px) scale(1)`, opacity: 0 }
            ];

            const anim = coin.animate(keyframes, {
                duration: duration + (Math.random() * 200),
                easing: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
                fill: 'forwards'
            });

            anim.onfinish = () => coin.remove();
        }, i * 100);
    }
}

// 4. Confetti
function fireConfetti() {
    const colors = ['#7c6cf0', '#00d4c8', '#ff6b6b', '#ffd166', '#fd79a8'];
    for (let i = 0; i < 50; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti';
        confetti.style.left = Math.random() * 100 + 'vw';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        // Random fall duration between 2s and 5s
        confetti.style.animationDuration = (Math.random() * 3 + 2) + 's';

        document.body.appendChild(confetti);

        setTimeout(() => confetti.remove(), 5000);
    }
}

// Hook into existing events for animations
// (We'll wrap the original socket handlers or just add new listeners if possible, 
// but since I'm appending, I'll add side-effects here)

// Listen for money-received to trigger animations
socket.on('money-received', ({ from, amount }) => {
    // Fly money from specific player card to my wallet
    const senderCard = Array.from(document.querySelectorAll('.balance-card')).find(c => c.querySelector('.balance-name').textContent.includes(from));
    const myWallet = document.querySelector('#my-wallet');
    if (senderCard && myWallet) {
        flyMoney(senderCard, myWallet, 5);
    }
    fireConfetti(); // Celebration!
});

socket.on('money-sent', ({ to, amount }) => {
    // Fly money from my wallet to receiver
    const receiverCard = Array.from(document.querySelectorAll('.balance-card')).find(c => c.querySelector('.balance-name').textContent.includes(to));
    const myWallet = document.querySelector('#my-wallet');
    if (receiverCard && myWallet) {
        flyMoney(myWallet, receiverCard, 5);
    }
});

// Join celebration
socket.on('player-joined', () => {
    fireConfetti();
});


// 5. 3D Tilt Effect for Cards
document.addEventListener('mousemove', (e) => {
    const cards = document.querySelectorAll('.balance-card');
    cards.forEach(card => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Only apply if mouse is near/over the card to save performance/visuals
        if (x > -20 && x < rect.width + 20 && y > -20 && y < rect.height + 20) {
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            const rotateX = ((y - centerY) / centerY) * -10; // Max 10deg rotation
            const rotateY = ((x - centerX) / centerX) * 10;

            card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.05)`;
        } else {
            // Reset if mouse is far
            card.style.transform = 'perspective(1000px) rotateX(0) rotateY(0) scale(1)';
        }
    });
});

