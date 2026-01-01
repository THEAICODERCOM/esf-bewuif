const { Client, GatewayIntentBits, ApplicationCommandOptionType, EmbedBuilder, PermissionFlagsBits, Events, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js'); 
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

// ---------------------------
// Load token
// ---------------------------
let DISCORD_TOKEN; 
try {
    DISCORD_TOKEN = fs.readFileSync('./token.txt', 'utf8').trim();
} catch {
    console.error("CRITICAL: token.txt is missing!");
    process.exit(1);
}

// ---------------------------
// Client & Database
// ---------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const db = new sqlite3.Database('./data.sqlite');
db.configure('busyTimeout', 5000);

db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');

    db.run('CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0, lastDaily INTEGER DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS user_quiz (userId TEXT PRIMARY KEY, quizId INTEGER NOT NULL, askedAt INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS quiz_cooldown (userId TEXT PRIMARY KEY, lastUsed INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS quiz_history (userId TEXT PRIMARY KEY, askedIds TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS guild_users (guildId TEXT NOT NULL, userId TEXT NOT NULL, PRIMARY KEY (guildId, userId))');
    db.run('CREATE TABLE IF NOT EXISTS quiz_stats (userId TEXT PRIMARY KEY, correct INTEGER NOT NULL DEFAULT 0, wrong INTEGER NOT NULL DEFAULT 0)');
});

// ---------------------------
// DB Helpers
// ---------------------------
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r)));

const getUserData = userId => new Promise((res, rej) => {
    db.get('SELECT coins, lastDaily FROM users WHERE userId = ?', [userId], (e, r) => {
        if (e) rej(e);
        else if (!r) {
            db.run('INSERT OR IGNORE INTO users (userId, coins, lastDaily) VALUES (?,0,0)', [userId], () => res({ coins: 0, lastDaily: 0 }));
        } else res(r);
    });
});

const addUserCoins = (userId, amount) => new Promise((res, rej) => {
    db.run('INSERT OR IGNORE INTO users (userId, coins) VALUES (?,0)', [userId], err => {
        if (err) return rej(err);
        db.run('UPDATE users SET coins = coins + ? WHERE userId = ?', [amount, userId], e => e ? rej(e) : res());
    });
});

const setActiveQuestion = (userId, quizId) => new Promise((res, rej) => {
    db.run(
        'INSERT INTO user_quiz (userId, quizId, askedAt) VALUES (?, ?, ?) ON CONFLICT(userId) DO UPDATE SET quizId=excluded.quizId, askedAt=excluded.askedAt',
        [userId, quizId, Date.now()],
        e => e ? rej(e) : res()
    );
});

const getActiveQuestion = userId => new Promise((res, rej) => {
    db.get('SELECT quizId, askedAt FROM user_quiz WHERE userId = ?', [userId], (e, r) => e ? rej(e) : res(r || null));
});

const clearActiveQuestion = userId => new Promise((res, rej) => db.run('DELETE FROM user_quiz WHERE userId = ?', [userId], e => e ? rej(e) : res()));

const getCooldown = userId => new Promise((res, rej) => db.get('SELECT lastUsed FROM quiz_cooldown WHERE userId = ?', [userId], (e, r) => e ? rej(e) : res(r || null)));
const setCooldown = userId => new Promise((res, rej) => db.run('INSERT INTO quiz_cooldown (userId, lastUsed) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET lastUsed=excluded.lastUsed', [userId, Date.now()], e => e ? rej(e) : res()));

const getQuizHistory = userId => new Promise((res, rej) => {
    db.get('SELECT askedIds FROM quiz_history WHERE userId = ?', [userId], (e, r) => {
        if (e) rej(e);
        res(r && r.askedIds ? r.askedIds.split(',').map(Number) : []);
    });
});

const addQuizToHistory = (userId, quizId) => new Promise((res, rej) => {
    getQuizHistory(userId).then(history => {
        if (!history.includes(quizId)) history.push(quizId);
        db.run('INSERT INTO quiz_history (userId, askedIds) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET askedIds=excluded.askedIds', [userId, history.join(',')], e => e ? rej(e) : res());
    });
});

const upsertGuildUser = (guildId, userId) => new Promise((res, rej) => {
    db.run('INSERT OR IGNORE INTO guild_users (guildId, userId) VALUES (?, ?)', [guildId, userId], e => e ? rej(e) : res());
});

const getQuizStats = userId => new Promise((res, rej) => {
    db.get('SELECT correct, wrong FROM quiz_stats WHERE userId = ?', [userId], (e, r) => {
        if (e) rej(e);
        else if (!r) res({ correct: 0, wrong: 0 });
        else res(r);
    });
});

const incQuizStat = (userId, column) => new Promise((res, rej) => {
    db.run('INSERT OR IGNORE INTO quiz_stats (userId, correct, wrong) VALUES (?, 0, 0)', [userId], err => {
        if (err) return rej(err);
        db.run(`UPDATE quiz_stats SET ${column} = ${column} + 1 WHERE userId = ?`, [userId], e => e ? rej(e) : res());
    });
});

// ---------------------------
// Logic Helpers
// ---------------------------
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, '');
const isCloseEnough = (u, a) => {
    u = norm(u); a = norm(a);
    if (!u || !a) return false;
    if (u === a) return true;
    let diff = 0;
    for (let i = 0; i < Math.min(u.length, a.length); i++) if (u[i] !== a[i]) diff++;
    diff += Math.abs(u.length - a.length);
    return diff <= (a.length > 6 ? 2 : 1);
};

const STOP_WORDS = new Set(['the','a','an','on','of','to','with','in','at','by','for','and','or','from','into','onto','over','under']);
const SYN_MAP = {
    "queenside": ["queen","side"],
    "queen's": ["queen"],
    "queens": ["queen"],
    "kingside": ["king","side"],
    "king's": ["king"],
    "kings": ["king"],
    "backrank": ["back","rank"],
    "fianchetto": ["fianchetto"],
    "enpassant": ["en","passant"],
    "en": ["en"],
    "passant": ["passant"],
    "castle": ["castling"],
    "o-o-o": ["castling","queen","side"],
    "o-o": ["castling","king","side"],
    "mate": ["checkmate"],
    "promotion": ["promotion","promote"],
    "promote": ["promotion"],
    "battery": ["battery","double"],
    "double": ["double"],
    "forking": ["fork"],
    "fork": ["fork"],
    "skewer": ["skewer"],
    "pin": ["pin"],
    "zugzwang": ["zugzwang"],
    "zwischenzug": ["zwischenzug","intermediate"],
    "intermediate": ["zwischenzug"],
    "gambit": ["gambit"],
    "declined": ["declined"],
    "accepted": ["accepted"],
    "defense": ["defense"],
    "attack": ["attack"],
    "break": ["break"],
    "pawn": ["pawn"],
    "rank": ["rank"],
    "file": ["file"],
    "queen": ["queen"],
    "king": ["king"],
    "rook": ["rook"],
    "bishop": ["bishop"],
    "knight": ["knight"]
};

const canonTokens = (s) => {
    if (!s) return new Set();
    s = String(s).toLowerCase().replace(/[^a-z0-9\s\-']/g, ' ');
    s = s.replace(/-/g, ' ');
    s = s.replace(/'/g, '');
    const raw = s.split(/\s+/).filter(Boolean);
    let tokens = [];
    for (const t of raw) {
        if (STOP_WORDS.has(t)) continue;
        if (SYN_MAP[t]) tokens.push(...SYN_MAP[t]);
        else tokens.push(t);
    }
    const out = new Set(tokens.filter(x => !STOP_WORDS.has(x)));
    return out;
};

const subsetMatch = (a, b) => {
    for (const t of a) { if (!b.has(t)) return false; }
    return true;
};

const isAnswerMatch = (input, q) => {
    const inSet = canonTokens(input);
    const ansSet = canonTokens(q.answer);
    if (subsetMatch(ansSet, inSet)) return true;
    if (Array.isArray(q.aliases)) {
        for (const al of q.aliases) {
            const alSet = canonTokens(al);
            if (subsetMatch(alSet, inSet)) return true;
        }
    }
    if (ansSet.size === 1) {
        if (isCloseEnough(input, q.answer)) return true;
        if (Array.isArray(q.aliases) && q.aliases.some(a => isCloseEnough(input, a))) return true;
    }
    return false;
};

// ---------------------------
// Quiz Pool & Shop
// ---------------------------
const QUIZ_POOL = [
    { id: 1, question: "How many squares are on a chessboard?", answer: "64", reward: 5 },
    { id: 2, question: "Which piece moves in an L-shape?", answer: "Knight", aliases: ["horse"], reward: 10 },
    { id: 3, question: "What is the term for attacking the king?", answer: "Check", reward: 10 },
    { id: 4, question: "What is the final aim of chess?", answer: "Checkmate", aliases: ["mate"], reward: 15 },
    { id: 5, question: "Which move lets king and rook move together?", answer: "Castling", aliases: ["castle"], reward: 15 },
    { id: 6, question: "Which color moves first?", answer: "White", reward: 5 },
    { id: 7, question: "Which piece moves any number of squares diagonally?", answer: "Bishop", reward: 10 },
    { id: 8, question: "Which piece combines rook and bishop movement?", answer: "Queen", reward: 15 },
    { id: 9, question: "Which piece moves forward and captures diagonally?", answer: "Pawn", reward: 10 },
    { id: 10, question: "What is the special pawn capture immediately after a two-step move called?", answer: "En passant", aliases: ["enpassant", "en passant capture"], reward: 15 },
    { id: 11, question: "What is promoting a pawn to a queen called?", answer: "Promotion", aliases: ["pawn promotion"], reward: 10 },
    { id: 12, question: "Name the opening starting with 1. e4 e5 2. Nf3 Nc6 3. Bb5.", answer: "Ruy Lopez", aliases: ["spanish"], reward: 15 },
    { id: 13, question: "Name the opening 1. d4 Nf6 2. c4 g6.", answer: "Indian Defense", aliases: ["kings indian", "queen's indian"], reward: 15 },
    { id: 14, question: "What is a draw due to a repeated position three times called?", answer: "Threefold repetition", aliases: ["threefold"], reward: 15 },
    { id: 15, question: "What is a draw when no legal moves and king is not in check?", answer: "Stalemate", reward: 15 },
    { id: 16, question: "What is the 50-move rule based on?", answer: "No pawn move or capture", aliases: ["fifty move rule"], reward: 15 },
    { id: 17, question: "What does FIDE stand for?", answer: "International Chess Federation", aliases: ["fide"], reward: 10 },
    { id: 18, question: "Who is known as the 'Mozart of chess'?", answer: "Magnus Carlsen", aliases: ["carlsen"], reward: 10 },
    { id: 19, question: "Who wrote 'My System'?", answer: "Aron Nimzowitsch", aliases: ["nimzowitsch"], reward: 15 },
    { id: 20, question: "Which opening starts with 1. e4 c5?", answer: "Sicilian Defense", aliases: ["sicilian"], reward: 15 },
    { id: 21, question: "Which opening starts with 1. d4 d5 2. c4?", answer: "Queen's Gambit", aliases: ["queens gambit"], reward: 15 },
    { id: 22, question: "Name the tactic: a move that creates two simultaneous threats.", answer: "Fork", reward: 10 },
    { id: 23, question: "Name the tactic: blocking a square to cut off defense.", answer: "Interference", reward: 10 },
    { id: 24, question: "Name the tactic: sacrificing material to open lines.", answer: "Sacrifice", reward: 10 },
    { id: 25, question: "Name the tactic: winning material by trapping a piece.", answer: "Trap", reward: 10 },
    { id: 26, question: "Name the tactic: attacking the king with a forcing move.", answer: "Check", reward: 5 },
    { id: 27, question: "Name the tactic: pinning a piece to a more valuable one.", answer: "Pin", reward: 10 },
    { id: 28, question: "Name the tactic: a piece behind another is attacked after the front moves.", answer: "Skewer", reward: 10 },
    { id: 29, question: "Name the tactic: decoying a piece onto a bad square.", answer: "Decoy", reward: 10 },
    { id: 30, question: "Name the tactic: removing the guard of a piece.", answer: "Deflection", aliases: ["remove the guard"], reward: 10 },
    { id: 31, question: "Which endgame is drawn with only king vs king?", answer: "King vs King", aliases: ["bare kings"], reward: 5 },
    { id: 32, question: "What is opposition in king and pawn endgames?", answer: "Kings facing each other with a square in between", aliases: ["opposition"], reward: 15 },
    { id: 33, question: "What is zugzwang?", answer: "Being forced to move to a worse position", reward: 15 },
    { id: 34, question: "Which piece is worth about 9 points?", answer: "Queen", reward: 5 },
    { id: 35, question: "Which piece is worth about 5 points?", answer: "Rook", reward: 5 },
    { id: 36, question: "Which piece is worth about 3 points (two types)?", answer: "Knight and Bishop", aliases: ["minor pieces"], reward: 10 },
    { id: 37, question: "What is the term for two bishops on adjacent diagonals", answer: "Bishop pair", aliases: ["two bishops"], reward: 10 },
    { id: 38, question: "What is a fianchetto?", answer: "Developing bishop to b2/g2/b7/g7", reward: 10 },
    { id: 39, question: "Name the tactic: discovered attack on a piece or king.", answer: "Discovered attack", reward: 10 },
    { id: 40, question: "Name the tactic: discovered check.", answer: "Discovered check", reward: 10 },
    { id: 41, question: "What is a double attack?", answer: "Two threats at once", reward: 10 },
    { id: 42, question: "What is perpetual check?", answer: "Repeated checks forcing a draw", reward: 15 },
    { id: 43, question: "What is a passed pawn?", answer: "Pawn with no opposing pawns blocking its path", reward: 10 },
    { id: 44, question: "What is an isolated pawn?", answer: "Pawn with no same-color pawns on adjacent files", reward: 10 },
    { id: 45, question: "What is a backward pawn?", answer: "Pawn behind others and cannot advance safely", reward: 10 },
    { id: 46, question: "What is a doubled pawn?", answer: "Two pawns on same file", reward: 10 },
    { id: 47, question: "What is a gambit?", answer: "Sacrificing material for initiative", reward: 10 },
    { id: 48, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bc4.", answer: "Italian Game", aliases: ["giuoco piano"], reward: 15 },
    { id: 49, question: "Name the opening: 1. e4 e5 2. Nf3 d6.", answer: "Philidor Defense", aliases: ["philidor"], reward: 15 },
    { id: 50, question: "Name the opening: 1. e4 e5 2. f4.", answer: "King's Gambit", aliases: ["kings gambit"], reward: 15 },
    { id: 51, question: "Name the opening: 1. d4 d5 2. Nf3 Nf6 3. c4.", answer: "Queen's Gambit Declined", aliases: ["qgd"], reward: 15 },
    { id: 52, question: "Name the opening: 1. d4 f5.", answer: "Dutch Defense", aliases: ["dutch"], reward: 15 },
    { id: 53, question: "Name the opening: 1. e4 e6.", answer: "French Defense", aliases: ["french"], reward: 15 },
    { id: 54, question: "Name the opening: 1. e4 d6.", answer: "Pirc Defense", aliases: ["pirc"], reward: 15 },
    { id: 55, question: "Name the opening: 1. e4 c6.", answer: "Caro-Kann Defense", aliases: ["caro kann"], reward: 15 },
    { id: 56, question: "Name the opening: 1. e4 d5.", answer: "Scandinavian Defense", aliases: ["center counter"], reward: 15 },
    { id: 57, question: "Name the opening: 1. e4 b6.", answer: "Owen's Defense", aliases: ["owens"], reward: 15 },
    { id: 58, question: "Name the opening: 1. e4 g6.", answer: "Modern Defense", aliases: ["modern"], reward: 15 },
    { id: 59, question: "Name the opening: 1. d4 Nf6 2. c4 e6.", answer: "Nimzo-Indian Defense", aliases: ["nimzo indian"], reward: 15 },
    { id: 60, question: "Name the opening: 1. d4 Nf6 2. c4 g6 3. Nc3 Bg7.", answer: "King's Indian Defense", aliases: ["kings indian"], reward: 15 },
    { id: 61, question: "Name the opening: 1. d4 d5 2. c4 c6.", answer: "Slav Defense", aliases: ["slav"], reward: 15 },
    { id: 62, question: "Name the opening: 1. d4 d5 2. c4 e6.", answer: "Queen's Gambit Declined", aliases: ["qgd"], reward: 15 },
    { id: 63, question: "Name the opening: 1. c4.", answer: "English Opening", aliases: ["english"], reward: 15 },
    { id: 64, question: "Name the opening: 1. Nf3.", answer: "Reti Opening", aliases: ["reti"], reward: 15 },
    { id: 65, question: "Name the opening: 1. b3.", answer: "Larsen's Opening", aliases: ["nimzo larsen"], reward: 15 },
    { id: 66, question: "Name the opening: 1. g3.", answer: "Hungarian Opening", aliases: ["kings fianchetto"], reward: 10 },
    { id: 67, question: "Which checkmate uses two rooks to trap the king on a rank or file?", answer: "Ladder mate", aliases: ["rook roller"], reward: 15 },
    { id: 68, question: "Which checkmate uses queen and bishop on h7/h2?", answer: "Scholar's mate", aliases: ["scholars"], reward: 10 },
    { id: 69, question: "Which checkmate pattern uses back rank weakness?", answer: "Back rank mate", reward: 10 },
    { id: 70, question: "Which mate involves bishop and knight coordinating?", answer: "Bishop and knight mate", reward: 15 },
    { id: 71, question: "Which mate involves smothered king with a knight?", answer: "Smothered mate", reward: 15 },
    { id: 72, question: "Which mate involves sacrifice on h7 followed by Ng5/Qh5?", answer: "Greek gift", aliases: ["greek gift sacrifice"], reward: 15 },
    { id: 73, question: "What is a blockade?", answer: "Placing a piece to stop an enemy pawn advance", reward: 10 },
    { id: 74, question: "What is prophylaxis?", answer: "Preventing opponent's plan", reward: 10 },
    { id: 75, question: "What is tempo?", answer: "A unit of time for a move advantage", reward: 10 },
    { id: 76, question: "What is initiative?", answer: "Ability to make threats forcing responses", reward: 10 },
    { id: 77, question: "What is a zwischenzug?", answer: "An in-between move", aliases: ["in-between"], reward: 15 },
    { id: 78, question: "What is a battery?", answer: "Two pieces lined up on a file, rank, or diagonal", reward: 10 },
    { id: 79, question: "What is a majority attack with pawns?", answer: "Pawn majority push", reward: 10 },
    { id: 80, question: "What is the square of the pawn rule?", answer: "King reaches square if inside pawn's square", reward: 15 },
    { id: 81, question: "What is triangulation in endgames?", answer: "Wasting moves to gain opposition", reward: 15 },
    { id: 82, question: "What is underpromotion?", answer: "Promoting to a piece other than queen", reward: 15 },
    { id: 83, question: "What is stalemate tactic for a draw?", answer: "Forcing no legal move without check", reward: 15 },
    { id: 84, question: "What is the main idea of the London System?", answer: "Setup with d4, Nf3, Bf4, e3, c3", aliases: ["london system"], reward: 15 },
    { id: 85, question: "Which opening starts with 1. d4 and Bf4 early?", answer: "London System", aliases: ["london"], reward: 15 },
    { id: 86, question: "Who was the first official World Chess Champion?", answer: "Wilhelm Steinitz", aliases: ["steinitz"], reward: 10 },
    { id: 87, question: "Who defeated Kasparov in 2000 to become World Champion?", answer: "Vladimir Kramnik", aliases: ["kramnik"], reward: 10 },
    { id: 88, question: "What is castling long?", answer: "Castling queenside", aliases: ["queenside castling", "o-o-o"], reward: 10 },
    { id: 89, question: "What is castling short?", answer: "Castling kingside", aliases: ["kingside castling", "o-o"], reward: 10 },
    { id: 90, question: "What is the en passant condition?", answer: "Capture only immediately after a two-step pawn move", reward: 15 },
    { id: 91, question: "What does ELO measure?", answer: "Player rating strength", aliases: ["elo rating"], reward: 10 },
    { id: 92, question: "What is the term for a line starting with a12? (illegal)", answer: "Illegal move", reward: 5 },
    { id: 93, question: "What is algebraic notation for checkmate?", answer: "#", aliases: ["hash"], reward: 5 },
    { id: 94, question: "What is algebraic notation for check?", answer: "+", aliases: ["plus"], reward: 5 },
    { id: 95, question: "What is the term for moving the same piece twice in the opening unnecessarily?", answer: "Loss of tempo", reward: 10 },
    { id: 96, question: "What is the doel of development?", answer: "Activate pieces quickly", aliases: ["development"], reward: 10 },
    { id: 97, question: "Where should you usually place rooks?", answer: "Open files", reward: 10 },
    { id: 98, question: "What is a half-open file?", answer: "File with no pawn of one side", reward: 10 },
    { id: 99, question: "What is the center in chess?", answer: "Squares e4, d4, e5, d5", reward: 10 },
    { id: 100, question: "What is a checkmate with queen and king called?", answer: "Basic mate", aliases: ["queen mate"], reward: 10 },
    { id: 101, question: "What is a checkmate with rook and king called?", answer: "Rook mate", reward: 10 },
    { id: 102, question: "What is the tactic of sacrificing an exchange called?", answer: "Exchange sacrifice", aliases: ["sacrifice exchange"], reward: 15 },
    { id: 103, question: "What is the tactic of doubling rooks on a file?", answer: "Rook battery", reward: 10 },
    { id: 104, question: "What is the tactic of opening a diagonal for a bishop?", answer: "Pawn break", reward: 10 },
    { id: 105, question: "Name the tactic: quiet move setting up a tactic next move.", answer: "Quiet move", reward: 10 },
    { id: 106, question: "What are connected passed pawns?", answer: "Adjacent passed pawns", reward: 10 },
    { id: 107, question: "What is a king's shelter of pawns called?", answer: "Pawn shield", reward: 10 },
    { id: 108, question: "Name the mate using queen sacrifice then smothered mate.", answer: "Levien/Philidor combination", aliases: ["queen sac smothered"], reward: 15 },
    { id: 109, question: "Name the mate pattern where queen mates on back rank with rook block.", answer: "Back rank mate", reward: 10 },
    { id: 110, question: "What is an outpost?", answer: "Strong square for knight or piece, hard to chase away", reward: 10 },
    { id: 111, question: "What is a hole in pawn structure?", answer: "Weak square that cannot be defended by pawns", reward: 10 },
    { id: 112, question: "Name the tactic: line-clearance for another piece.", answer: "Clearance", reward: 10 },
    { id: 113, question: "Name the tactic: 'windmill' with rook/bishop discovering checks.", answer: "Windmill", reward: 15 },
    { id: 114, question: "What is the most valuable piece?", answer: "King", reward: 5 },
    { id: 115, question: "What is a draw by insufficient mating material?", answer: "Insufficient material", reward: 10 },
    { id: 116, question: "What is perpetual pursuit?", answer: "Repeated threats to force draw", reward: 10 },
    { id: 117, question: "What is a hook pawn?", answer: "Pawn used to create pawn storms", reward: 10 },
    { id: 118, question: "What is a minority attack?", answer: "Using fewer pawns to attack more pawns", reward: 10 },
    { id: 119, question: "What is the strongest square for knights usually?", answer: "Outposts in center", reward: 10 },
    { id: 120, question: "What is the rook on the seventh rank called?", answer: "Rook on seventh", aliases: ["rook on 7th"], reward: 10 },
    { id: 121, question: "Name the endgame: rook vs pawn with king support is often drawn if pawn is rook pawn.", answer: "Rook vs rook pawn draw", reward: 15 },
    { id: 122, question: "What is opposition diagonal called for bishops?", answer: "Opposite-colored bishops", reward: 10 },
    { id: 123, question: "Opposite-colored bishops endgames often result in what?", answer: "Draw", reward: 10 },
    { id: 124, question: "Same-colored bishops endgames are often decided by what?", answer: "Pawn breaks and zugzwang", reward: 15 },
    { id: 125, question: "Name the opening line: 1. e4 e5 2. Nf3 Nc6 3. d4.", answer: "Scotch Game", aliases: ["scotch"], reward: 15 },
    { id: 126, question: "Name the defense: 1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6.", answer: "Najdorf", aliases: ["sicilian najdorf"], reward: 15 },
    { id: 127, question: "Name the line: 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6.", answer: "Ruy Lopez, Morphy Defense", aliases: ["morphy defense"], reward: 15 },
    { id: 128, question: "Name the gambit: 1. d4 d5 2. c4 e6 3. Nc3 c5.", answer: "Tarrasch Defense", aliases: ["tarrasch"], reward: 15 },
    { id: 129, question: "Name the opening: 1. d4 Nf6 2. c4 e6 3. Nc3 Bb4.", answer: "Nimzo-Indian Defense", reward: 15 },
    { id: 130, question: "Name the opening: 1. d4 Nf6 2. c4 g6 3. g3.", answer: "Fianchetto King's Indian", aliases: ["kings indian fianchetto"], reward: 15 },
    { id: 131, question: "Name the pawn structure with pawns on c3/d4/e3.", answer: "Stonewall-like (London) structure", aliases: ["stonewall", "london"], reward: 10 },
    { id: 132, question: "Name the tactic: overload a defender to win material.", answer: "Overloading", reward: 10 },
    { id: 133, question: "Name the tactic: prevent castling by pinning f-pawn or attacking g-pawn.", answer: "King safety attack", reward: 10 },
    { id: 134, question: "What is the main goal of the opening?", answer: "Development and king safety", reward: 10 },
    { id: 135, question: "What is the main goal of the middlegame?", answer: "Create weaknesses and attack", reward: 10 },
    { id: 136, question: "What is the main goal of the endgame?", answer: "Push passed pawns and activate king", reward: 10 },
    { id: 137, question: "What is the term for exchanging queens early?", answer: "Early queen trade", aliases: ["queen trade"], reward: 10 },
    { id: 138, question: "What is the best piece to blockade passed pawns?", answer: "Knight", reward: 10 },
    { id: 139, question: "What is the tactic theme when king is trapped by own pieces?", answer: "Self-mate motifs", reward: 10 },
    { id: 140, question: "What is the term for a pawn storm?", answer: "Pawn storm", reward: 10 },
    { id: 141, question: "What is the Dutch Leningrad setup's key pawn?", answer: "f-pawn", aliases: ["leningrad key pawn"], reward: 10 },
    { id: 142, question: "Which opening features the Botvinnik setup c4, e4, d3, Nc3, g3?", answer: "English, Botvinnik System", aliases: ["botvinnik"], reward: 15 },
    { id: 143, question: "Which defense uses ...c5 against 1.d4?", answer: "Benoni Defense", aliases: ["benoni"], reward: 15 },
    { id: 144, question: "Which defense uses ...b5 early against 1.d4 c4?", answer: "Budapest Gambit", aliases: ["budapest"], reward: 15 },
    { id: 145, question: "Which system is known for solid pawn chain d5-e6?", answer: "French Defense", reward: 10 },
    { id: 146, question: "Name the tactic: removing the defender with a capture.", answer: "Remove the defender", aliases: ["deflection"], reward: 10 },
    { id: 147, question: "Name the classic endgame study composer: Troitsky.", answer: "Alexey Troitsky", aliases: ["troitsky"], reward: 10 },
    { id: 148, question: "What is the Troitsky line about?", answer: "Knight vs two connected passed pawns", reward: 15 },
    { id: 149, question: "What is an exchange up?", answer: "Having a rook for a minor piece", reward: 10 },
    { id: 150, question: "What is a material imbalance?", answer: "Unequal material values", reward: 10 },
    { id: 151, question: "What is fortress?", answer: "Defensive setup preventing progress", reward: 15 },
    { id: 152, question: "What is the term for pre-move in online chess?", answer: "Premove", reward: 5 },
    { id: 153, question: "What is castling condition about moving king or rook previously?", answer: "Cannot castle if moved before", reward: 15 },
    { id: 154, question: "What is the term for pin against the king?", answer: "Absolute pin", reward: 10 },
    { id: 155, question: "What is the term for pin against a queen or rook?", answer: "Relative pin", reward: 10 },
    { id: 156, question: "What is time trouble called?", answer: "Zeitnot", reward: 10 },
    { id: 157, question: "What is the move repetition draw rule?", answer: "Threefold repetition", reward: 15 },
    { id: 158, question: "Name the defense: 1. d4 Nf6 2. c4 e5.", answer: "Budapest Gambit", reward: 15 },
    { id: 159, question: "Name the defense: 1. d4 c5.", answer: "Benoni Defense", reward: 15 },
    { id: 160, question: "Name the defense: 1. d4 d6 2. c4 e5.", answer: "Old Indian Defense", aliases: ["old indian"], reward: 15 },
    { id: 161, question: "Name the opening: 1. e4 Nf6.", answer: "Alekhine Defense", aliases: ["alekhine"], reward: 15 },
    { id: 162, question: "Name the opening: 1. e4 Nc6.", answer: "Nimzowitsch Defense", aliases: ["nimzowitsch"], reward: 15 },
    { id: 163, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. d3.", answer: "King's Pawn, Old Italian", aliases: ["old italian"], reward: 15 },
    { id: 164, question: "Name the opening: 1. e4 e5 2. Nf3 Nf6.", answer: "Petrov Defense", aliases: ["russian"], reward: 15 },
    { id: 165, question: "Name the opening: 1. e4 e5 2. Qh5.", answer: "Parham Attack", aliases: ["parham"], reward: 10 },
    { id: 166, question: "Name the opening: 1. e4 e5 2. Qf3.", answer: "Wayward Queen Attack", aliases: ["wayward queen"], reward: 10 },
    { id: 167, question: "Name the opening: 1. e4 d5 2. exd5 Qxd5 3. Nc3.", answer: "Scandinavian Defense, Mieses-Kotrc", aliases: ["scandi"], reward: 15 },
    { id: 168, question: "Name the opening: 1. d4 d5 2. c4 dxc4.", answer: "Queen's Gambit Accepted", aliases: ["qga"], reward: 15 },
    { id: 169, question: "Name the opening: 1. d4 d5 2. c4 e5.", answer: "Albin Counter-Gambit", aliases: ["albin"], reward: 15 },
    { id: 170, question: "Name the opening: 1. e4 c5 2. Nf3 Nc6 3. Bb5.", answer: "Sicilian Rossolimo", aliases: ["rossolimo"], reward: 15 },
    { id: 171, question: "Name the opening: 1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6.", answer: "Sicilian Dragon", aliases: ["dragon"], reward: 15 },
    { id: 172, question: "Name the opening: 1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 a6.", answer: "Sicilian Kan", aliases: ["kan"], reward: 15 },
    { id: 173, question: "Name the opening: 1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nc6.", answer: "Sicilian Taimanov", aliases: ["taimanov"], reward: 15 },
    { id: 174, question: "Name the opening: 1. e4 c5 2. Nf3 d6 3. c3.", answer: "Sicilian Alapin", aliases: ["alapin"], reward: 15 },
    { id: 175, question: "Name the tactic: attack along the long diagonal a1-h8 or h1-a8.", answer: "Diagonal attack", reward: 10 },
    { id: 176, question: "Name the tactic: mating net around the king.", answer: "Mating net", reward: 10 },
    { id: 177, question: "Name the tactic: push passed pawn supported by pieces.", answer: "Pawn push", reward: 10 },
    { id: 178, question: "Name the tactic: simplify to winning endgame.", answer: "Simplification", reward: 10 },
    { id: 179, question: "Name the tactic: exchange into favorable structure.", answer: "Structural transformation", reward: 10 },
    { id: 180, question: "What is the best piece in open positions?", answer: "Bishop", reward: 10 },
    { id: 181, question: "What is the best piece in closed positions?", answer: "Knight", reward: 10 },
    { id: 182, question: "What is the main principle of two weaknesses?", answer: "Create a second front to overload defense", reward: 15 },
    { id: 183, question: "Name the defense system with pawns on d6/e5/f7 and g6.", answer: "Pirc/Modern setup", reward: 10 },
    { id: 184, question: "Name the sacrifice on b5/b4 to open files in Sicilian.", answer: "Exchange sacrifice on c3", aliases: ["xc3 sac"], reward: 15 },
    { id: 185, question: "Name the tactic: capturing on h7/h2 to drag king out.", answer: "Bishop sacrifice on h7/h2", reward: 15 },
    { id: 186, question: "Name the endgame: king and pawn vs king key technique.", answer: "Opposition and square of the pawn", reward: 15 },
    { id: 187, question: "Name the ending: rook and bishop vs rook is usually a draw.", answer: "Rook and bishop vs rook draw", reward: 15 },
    { id: 188, question: "Name the ending: rook and knight vs rook drawish?", answer: "Rook and knight vs rook often draw", reward: 15 },
    { id: 189, question: "Name the ending: queen vs rook with poor king placement is winning for queen.", answer: "Queen vs rook win", reward: 15 },
    { id: 190, question: "Name the tactic: interference on defensive line.", answer: "Interference", reward: 10 },
    { id: 191, question: "Name the tactic: sacrifice to remove king safety.", answer: "King hunt", reward: 10 },
    { id: 192, question: "Name the tactic: clearing a file for rook penetration.", answer: "File clearance", reward: 10 },
    { id: 193, question: "Name the tactic: delaying recapture to play a stronger move.", answer: "Intermediate move", aliases: ["zwischenzug"], reward: 15 },
    { id: 194, question: "Name the tactic: mate threats that force a win of material.", answer: "Mating threats", reward: 10 },
    { id: 195, question: "Name the tactic: pin and win a piece.", answer: "Pin tactic", reward: 10 },
    { id: 196, question: "Name the tactic: skewer to win major piece.", answer: "Skewer tactic", reward: 10 },
    { id: 197, question: "Name the tactic: discovered attack on queen.", answer: "Discovered attack", reward: 10 },
    { id: 198, question: "Name the tactic: fork with knight on queen and rook.", answer: "Knight fork", reward: 10 },
    { id: 199, question: "Name the tactic: back rank mating pattern", answer: "Back rank mate", reward: 10 },
    { id: 200, question: "Name the opening strategy: put pressure on d4 in Sicilian.", answer: "Pressure on d4", reward: 10 },
    { id: 201, question: "Name the opening strategy: advance e5 in French to gain space.", answer: "Space advantage", reward: 10 },
    { id: 202, question: "Name the opening strategy: break with c4 in Queen's Gambit structures.", answer: "c4 break", reward: 10 },
    { id: 203, question: "Name the player known for King's Indian mastery.", answer: "Garry Kasparov", aliases: ["kasparov"], reward: 10 },
    { id: 204, question: "Name the player known as the Wizard of Riga.", answer: "Mikhail Tal", aliases: ["tal"], reward: 10 },
    { id: 205, question: "Name the player known for deep strategy and endgames.", answer: "Jose Raul Capablanca", aliases: ["capablanca"], reward: 10 },
    { id: 206, question: "Name the player who authored 'How to Reassess Your Chess'.", answer: "Jeremy Silman", aliases: ["silman"], reward: 10 },
    { id: 207, question: "Name the tournament: Candidates determines challenger for world title.", answer: "Candidates Tournament", aliases: ["candidates"], reward: 10 },
    { id: 208, question: "Name the defense with black playing ...e5 against 1. d4.", answer: "Budapest Gambit", reward: 15 },
    { id: 209, question: "Name the defense with black playing ...c5 vs 1. d4.", answer: "Benoni Defense", reward: 15 },
    { id: 210, question: "Name the defense featuring ...b6 and ...Bb7 vs 1. e4.", answer: "Owen's Defense", reward: 15 },
    { id: 211, question: "Name the endgame concept: 'rule of the square'.", answer: "Square of the pawn", reward: 15 },
    { id: 212, question: "Name the basic mating pattern with two bishops.", answer: "Two bishops mate", reward: 15 },
    { id: 213, question: "Name the principle: don't move pawns in front of your king unnecessarily.", answer: "King safety", reward: 10 },
    { id: 214, question: "Name the principle: centralize your pieces.", answer: "Centralization", reward: 10 },
    { id: 215, question: "Name the principle: avoid placing knights on the rim.", answer: "Knight on the rim is dim", reward: 10 },
    { id: 216, question: "Name the principle: rooks belong behind passed pawns.", answer: "Rooks behind passed pawns", reward: 10 },
    { id: 217, question: "Name the principle: opposite side castling often leads to pawn storms.", answer: "Opposite side castling", reward: 10 },
    { id: 218, question: "Name the principle: don't grab poisoned pawns.", answer: "Poisoned pawn", reward: 10 },
    { id: 219, question: "Name the Sicilian line with Qb6 hitting b2.", answer: "Poisoned Pawn Najdorf", aliases: ["poisoned pawn"], reward: 15 },
    { id: 220, question: "Name the defense: 1. e4 d6 2. d4 Nf6 3. Nc3 g6.", answer: "Pirc Defense", reward: 15 },
    { id: 221, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6.", answer: "Two Knights Defense", aliases: ["two knights"], reward: 15 },
    { id: 222, question: "Name the trap in the Two Knights with Ng5 and Bxf7+.", answer: "Fried Liver Attack", aliases: ["fried liver"], reward: 15 },
    { id: 223, question: "Name the declined version avoiding fried liver: 3...d6.", answer: "Steinitz Defense", aliases: ["steinitz"], reward: 10 },
    { id: 224, question: "Name the tactic: attacking pinned knight on f6 in Sicilian.", answer: "Pin and pressure", reward: 10 },
    { id: 225, question: "Name the tactic: queen sacrifice leading to forced mate.", answer: "Queen sacrifice mate", reward: 15 },
    { id: 226, question: "Name the endgame: rook vs rook with extra pawn typically winning.", answer: "Lucena position", aliases: ["lucena"], reward: 15 },
    { id: 227, question: "Name the defensive endgame method building a bridge.", answer: "Lucena technique", reward: 15 },
    { id: 228, question: "Name the defensive endgame fortress against rook ending.", answer: "Philidor position", aliases: ["philidor position"], reward: 15 },
    { id: 229, question: "Name the concept: second rank weakness around your king.", answer: "Back rank weakness", reward: 10 },
    { id: 230, question: "Name the motif: knight outpost on d5 in Sicilian structures.", answer: "d5 outpost", reward: 10 },
    { id: 231, question: "Name the motif: pawn break f4/f5 in King’s Indian.", answer: "f-pawn break", reward: 10 },
    { id: 232, question: "Name the motif: c5 break in French to hit d4.", answer: "c5 break", reward: 10 },
    { id: 233, question: "Name the motif: e4/e5 break to open center.", answer: "Center break", reward: 10 },
    { id: 234, question: "Name the motif: long castle opposite side attack.", answer: "Pawn storm", reward: 10 },
    { id: 235, question: "Name the motif: rook lift along the third rank.", answer: "Rook lift", reward: 10 },
    { id: 236, question: "Name the motif: exchange sacrifice on c3 in Sicilian.", answer: "Exchange sac on c3", reward: 15 },
    { id: 237, question: "Name the motif: bishop sacrifice on h7 for attack.", answer: "Greek gift", reward: 15 },
    { id: 238, question: "Name the motif: knight sacrifice on f7/f2.", answer: "Knight sacrifice on f7", reward: 15 },
    { id: 239, question: "Name the motif: rook sacrifice on h8/h1 for attack.", answer: "Rook sacrifice", reward: 15 },
    { id: 240, question: "Name the motif: clearance of g-file for rook attack.", answer: "g-file clearance", reward: 10 },
    { id: 241, question: "Name the motif: bishop on long diagonal b1-h7 attack.", answer: "Long diagonal attack", reward: 10 },
    { id: 242, question: "Name the motif: queen and knight attack on h7/h2.", answer: "Q+N attack", reward: 10 },
    { id: 243, question: "Name the motif: mating net with queen and rook.", answer: "Queen-rook mate", reward: 10 },
    { id: 244, question: "Name the motif: mating net with rook rook (ladder).", answer: "Ladder mate", reward: 10 },
    { id: 245, question: "Name the motif: discovered attack with bishop and rook.", answer: "Discovered attack", reward: 10 },
    { id: 246, question: "Name the motif: remove the guard and win material.", answer: "Deflection", reward: 10 },
    { id: 247, question: "Name the motif: trapping a piece with pawns.", answer: "Trapping", reward: 10 },
    { id: 248, question: "Name the motif: overprotecting a strong square.", answer: "Overprotection", reward: 10 },
    { id: 249, question: "Name the motif: break with b4/b5 in queenside structures.", answer: "Queenside pawn break", reward: 10 },
    { id: 250, question: "Name the motif: break with f4/f5 in kingside structures.", answer: "Kingside pawn break", reward: 10 },
    { id: 251, question: "Name the motif: rook on open file penetrates to 7th.", answer: "Rook penetration", reward: 10 },
    { id: 252, question: "Name the motif: double rooks on a file.", answer: "Rook doubling", reward: 10 },
    { id: 253, question: "Name the motif: queen-side minority attack in Carlsbad.", answer: "Minority attack", reward: 15 },
    { id: 254, question: "Name the motif: bishop pair advantage.", answer: "Bishop pair", reward: 10 },
    { id: 255, question: "Name the motif: knight vs bad bishop in closed positions.", answer: "Good knight vs bad bishop", reward: 10 },
    { id: 256, question: "Name the motif: rook behind passed pawn.", answer: "Rook behind passed pawn", reward: 10 },
    { id: 257, question: "Name the motif: king activity in endgame.", answer: "Active king", reward: 10 },
    { id: 258, question: "Name the motif: triangulation to win tempo.", answer: "Triangulation", reward: 15 },
    { id: 259, question: "Name the motif: zugzwang to force concessions.", answer: "Zugzwang", reward: 15 },
    { id: 260, question: "Name the motif: perpetual check to draw.", answer: "Perpetual check", reward: 15 },
    { id: 261, question: "Name the motif: stalemate resource to draw.", answer: "Stalemate", reward: 15 },
    { id: 262, question: "Name the motif: fortress to hold a draw.", answer: "Fortress", reward: 15 },
    { id: 263, question: "Name the motif: squeeze technique improving positions slowly.", answer: "Positional squeeze", reward: 10 },
    { id: 264, question: "Name the motif: prophylaxis preventing opponent's ideas.", answer: "Prophylaxis", reward: 10 },
    { id: 265, question: "Name the motif: interference to block lines.", answer: "Interference", reward: 10 },
    { id: 266, question: "Name the motif: clearance sacrifice.", answer: "Clearance sacrifice", reward: 15 },
    { id: 267, question: "Name the motif: attraction decoy.", answer: "Decoy", reward: 10 },
    { id: 268, question: "Name the motif: double attack with queen.", answer: "Double attack", reward: 10 },
    { id: 269, question: "Name the motif: skewer against king and rook.", answer: "Skewer", reward: 10 },
    { id: 270, question: "Name the motif: pin against queen.", answer: "Relative pin", reward: 10 },
    { id: 271, question: "Name the motif: absolute pin against king.", answer: "Absolute pin", reward: 10 },
    { id: 272, question: "Name the motif: underpromotion to knight to avoid stalemate.", answer: "Underpromotion", reward: 15 },
    { id: 273, question: "Name the motif: square of the pawn in king and pawn endings.", answer: "Square of the pawn", reward: 15 },
    { id: 274, question: "Name the motif: building bridge in rook endings.", answer: "Lucena", reward: 15 },
    { id: 275, question: "Name the motif: defensive technique against rook + pawn.", answer: "Philidor", reward: 15 },
    { id: 276, question: "Name the motif: opposition in pawn endings.", answer: "Opposition", reward: 15 },
    { id: 277, question: "Name the motif: queen sacrifice to force mate.", answer: "Queen sac mate", reward: 15 },
    { id: 278, question: "Name the motif: bishop and knight mate technique.", answer: "Bishop and knight mate", reward: 15 },
    { id: 279, question: "Name the motif: rook roller ladder mate.", answer: "Rook roller", reward: 10 },
    { id: 280, question: "Name the motif: smothered mate pattern with knight.", answer: "Smothered mate", reward: 15 },
    { id: 281, question: "Name the motif: mate net with Qh7+ or Qh2+", answer: "Greek gift ideas", reward: 15 },
    { id: 282, question: "Name the opening: 1. d4 Nf6 2. c4 c5.", answer: "Benoni/Benko ideas", aliases: ["benko"], reward: 15 },
    { id: 283, question: "Name the opening: 1. d4 Nf6 2. c4 c5 3. d5 b5.", answer: "Benko Gambit", aliases: ["benko"], reward: 15 },
    { id: 284, question: "Name the opening: 1. d4 f5 2. c4 Nf6 3. g3.", answer: "Dutch, Leningrad", aliases: ["leningrad"], reward: 15 },
    { id: 285, question: "Name the opening: 1. d4 d5 2. Bf4.", answer: "London System", reward: 15 },
    { id: 286, question: "Name the opening: 1. d4 d5 2. c4 e6 3. Nc3 Be7.", answer: "QGD Orthodox", aliases: ["orthodox"], reward: 15 },
    { id: 287, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6.", answer: "Berlin Defense", aliases: ["berlin"], reward: 15 },
    { id: 288, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 d6.", answer: "Steinitz Defense (Ruy)", reward: 15 },
    { id: 289, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 g6.", answer: "Ruy Lopez, Smyslov Defense", aliases: ["smyslov"], reward: 15 },
    { id: 290, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5.", answer: "Ruy Lopez, Classical", aliases: ["classical"], reward: 15 },
    { id: 291, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6.", answer: "Ruy Lopez, Closed", aliases: ["closed ruy"], reward: 15 },
    { id: 292, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 b5.", answer: "Ruy Lopez, Arkhangelsk", aliases: ["arkhangelsk"], reward: 15 },
    { id: 293, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 Nd4.", answer: "Ruy Lopez, Bird Defense", aliases: ["bird defense"], reward: 15 },
    { id: 294, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 f5.", answer: "Ruy Lopez, Schliemann Defense", aliases: ["schliemann"], reward: 15 },
    { id: 295, question: "Name the opening: 1. e4 c5 2. c3.", answer: "Sicilian Alapin", reward: 15 },
    { id: 296, question: "Name the opening: 1. e4 c5 2. Nc3.", answer: "Sicilian Closed", aliases: ["closed sicilian"], reward: 15 },
    { id: 297, question: "Name the opening: 1. e4 c5 2. d4 cxd4 3. c3.", answer: "Sicilian Smith-Morra", aliases: ["smith morra"], reward: 15 },
    { id: 298, question: "Name the opening: 1. e4 Nf6 2. e5 Nd5.", answer: "Alekhine Defense, Modern", reward: 15 },
    { id: 299, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5.", answer: "Italian Game, Giuoco Piano", aliases: ["giuoco piano"], reward: 15 },
    { id: 300, question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6.", answer: "Italian, Two Knights Defense", aliases: ["two knights"], reward: 15 }
];

const SHOP = [
    { name: 'Chess Beginner', description: 'Starter role for new players.', price: 25, roleId: '1455250623510614157' },
    { name: 'Chess Improver', description: 'Shows dedication to improving.', price: 75, roleId: '1455250690892107961' },
    { name: 'Chess Pro', description: 'Recognizes strong consistent play.', price: 200, roleId: '1455250740653330453' },
    { name: 'Chess Master', description: 'Highlights elite skill and strategy.', price: 500, roleId: '1455250877999747214' },
    { name: 'Chess GOAT', description: 'Top-tier recognition across the server.', price: 1000, roleId: '1455250931473191148' }
];

// ---------------------------
// Register commands
// ---------------------------
client.once(Events.ClientReady, async () => {
    try {
        await client.application.commands.set([
            { name: 'daily', description: 'Claim your daily 25 coins' },
            { name: 'balance', description: 'Check coins', options: [{ name: 'user', description: 'User to check', type: ApplicationCommandOptionType.User, required: false }] },
            { name: 'leaderboard', description: 'Top 10 players', options: [{ name: 'scope', description: 'Leaderboard scope', type: ApplicationCommandOptionType.String, required: false, choices: [{ name: 'Global', value: 'global' }, { name: 'Server', value: 'server' }] }] },
            { name: 'shop', description: 'View shop' },
            { name: 'chessquiz', description: 'Get a question (10m cooldown)' },
            { name: 'answer', description: 'Answer the quiz', options: [{ name: 'text', description: 'Your chess answer', type: ApplicationCommandOptionType.String, required: true }] },
            { name: 'ration', description: 'Show your quiz stats' },
            { name: 'questions', description: 'Admin: View quiz questions', default_member_permissions: PermissionFlagsBits.Administrator.toString(), options: [{ name: 'page', description: 'Page number (1-15)', type: ApplicationCommandOptionType.Integer, required: false }] },
            { name: 'addmoney', description: 'Admin: Add coins', default_member_permissions: PermissionFlagsBits.Administrator.toString(), options: [{ name: 'user', description: 'User to give coins', type: ApplicationCommandOptionType.User, required: true }, { name: 'amount', description: 'Amount of coins to add', type: ApplicationCommandOptionType.Integer, required: true }] },
            { name: 'removemoney', description: 'Admin: Remove coins', default_member_permissions: PermissionFlagsBits.Administrator.toString(), options: [{ name: 'user', description: 'User to remove coins', type: ApplicationCommandOptionType.User, required: true }, { name: 'amount', description: 'Amount of coins to remove', type: ApplicationCommandOptionType.Integer, required: true }] }
        ]);
        console.log(`✅ Logged in as ${client.user.tag}`);
    } catch (err) {
        console.error("Command Registration Error:", err);
    }
});

// ---------------------------
// Quiz logic
// ---------------------------
async function getRandomQuizForUser(userId) {
    const history = await getQuizHistory(userId);
    const remaining = QUIZ_POOL.filter(q => !history.includes(q.id));
    if (remaining.length === 0) {
        await new Promise(res => db.run('DELETE FROM quiz_history WHERE userId = ?', [userId], res));
        return QUIZ_POOL[Math.floor(Math.random() * QUIZ_POOL.length)];
    }
    return remaining[Math.floor(Math.random() * remaining.length)];
}

// ---------------------------
// Interaction Handler
// ---------------------------
client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isButton()) {
        const { customId, user, guild } = interaction;
        await interaction.deferUpdate().catch(() => {});
        try {
            if (customId === 'shop_close') {
                await interaction.editReply({ components: [] });
                return;
            }
            if (customId.startsWith('shop_buy:')) {
                const roleId = customId.split(':')[1];
                const item = SHOP.find(s => s.roleId === roleId);
                if (!item) { await interaction.followUp({ content: "Item not found.", ephemeral: true }); return; }
                const member = await guild.members.fetch(user.id);
                if (member.roles.cache.has(roleId)) { await interaction.followUp({ content: "You already own this role.", ephemeral: true }); return; }
                const data = await getUserData(user.id);
                if (data.coins < item.price) { await interaction.followUp({ content: "Insufficient funds to buy this item.", ephemeral: true }); return; }
                const role = guild.roles.cache.get(roleId);
                if (!role) { await interaction.followUp({ content: "Role not found in this server.", ephemeral: true }); return; }
                await member.roles.add(roleId);
                await addUserCoins(user.id, -item.price);
                const newMember = await guild.members.fetch(user.id);
                const newData = await getUserData(user.id);
                const fields = SHOP.map(s => {
                    const owned = newMember.roles.cache.has(s.roleId);
                    const roleMention = `<@&${s.roleId}>`;
                    const ownedTxt = owned ? "Already Owned" : "Not Owned";
                    return { name: `♟️ ${s.name}`, value: `📝 Description: ${s.description}\n💰 Price: ${s.price} coins\n🎭 Role: ${roleMention}\n✅ Status: ${ownedTxt}`, inline: false };
                });
                const embed = new EmbedBuilder().setTitle(`🛒 Server Shop • Balance: ${newData.coins} coins`).addFields(fields).setColor(0x3498DB);
                const buttons = SHOP.map(s => {
                    const owned = newMember.roles.cache.has(s.roleId);
                    const label = owned ? `Owned: ${s.name}` : `Buy ${s.name} • ${s.price} Coins`;
                    return new ButtonBuilder().setCustomId(`shop_buy:${s.roleId}`).setLabel(label).setEmoji('🛒').setStyle(owned ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(owned);
                });
                const rows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
                }
                rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop_close').setLabel('Close Shop').setEmoji('🧹').setStyle(ButtonStyle.Danger)));
                await interaction.editReply({ embeds: [embed], components: rows });
                await interaction.followUp({ content: `You successfully bought the ${item.name} role!`, ephemeral: true });
                return;
            }
            await interaction.followUp({ content: "This button action is no longer valid.", ephemeral: true });
        } catch (err) {
            console.error("Button Interaction Error:", err);
            await interaction.followUp({ content: "An error occurred while processing your action.", ephemeral: true }).catch(() => {});
        }
        return;
    }
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply().catch(() => {});

    const { commandName, user, options, guild } = interaction;

    if (guild) {
        try { await upsertGuildUser(guild.id, user.id); } catch {}
    }

    try {
        if (commandName === 'chessquiz') {
            const active = await getActiveQuestion(user.id);
            const timeLimitMs = 20 * 1000;
            if (active) {
                const elapsed = Date.now() - active.askedAt;
                if (elapsed > timeLimitMs) {
                    await incQuizStat(user.id, 'wrong');
                    await clearActiveQuestion(user.id);
                    await setCooldown(user.id);
                    await addQuizToHistory(user.id, active.quizId);
                } else {
                    const remaining = Math.ceil((timeLimitMs - elapsed) / 1000);
                    return interaction.editReply(`❗ Answer your current question first! Time left: ${remaining}s`);
                }
            }
            const row = await getCooldown(user.id);
            const cooldownTime = 10 * 60 * 1000;
            if (row && (Date.now() - row.lastUsed < cooldownTime)) {
                const diff = cooldownTime - (Date.now() - row.lastUsed);
                const h = Math.floor(diff / 3600000);
                const m = Math.floor((diff % 3600000) / 60000);
                const embed = new EmbedBuilder()
                    .setTitle("⏳ Cooldown Active")
                    .setDescription(`Try again in **${h}h ${m}m**.`)
                    .setColor(0x95A5A6);
                return interaction.editReply({ embeds: [embed] });
            }
            const q = await getRandomQuizForUser(user.id);
            await setActiveQuestion(user.id, q.id);
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("🧠 Chess Quiz")
                        .setDescription(`❓ ${q.question}\n⏱️ You have 20s. Use /answer`)
                        .setColor(0x00FF00)
                        .setFooter({ text: `Reward: ${q.reward} coins` })
                ]
            });
        }

        if (commandName === 'answer') {
            const active = await getActiveQuestion(user.id);
            if (!active) return interaction.editReply("❌ No active quiz. Use `/chessquiz`.");
            
            const q = QUIZ_POOL.find(i => i.id === active.quizId);
            const input = options.getString('text');
            const timeLimitMs = 20 * 1000;
            const timedOut = (Date.now() - active.askedAt) > timeLimitMs;
            const correct = isAnswerMatch(input, q);
            
            await clearActiveQuestion(user.id);
            await setCooldown(user.id);
            await addQuizToHistory(user.id, q.id);

            if (!timedOut && correct) {
                await incQuizStat(user.id, 'correct');
                await addUserCoins(user.id, q.reward);
                const embed = new EmbedBuilder()
                    .setTitle("✅ Correct Answer")
                    .setDescription(`You earned **${q.reward}** coins.\nAnswer: ${q.answer}`)
                    .setColor(0x2ECC71);
                return interaction.editReply({ embeds: [embed] });
            }
            await incQuizStat(user.id, 'wrong');
            const embed = timedOut
                ? new EmbedBuilder()
                    .setTitle("⏱️ Time's Up")
                    .setDescription(`Correct answer: **${q.answer}**`)
                    .setColor(0xE67E22)
                : new EmbedBuilder()
                    .setTitle("❌ Wrong Answer")
                    .setDescription(`Correct answer: **${q.answer}**`)
                    .setColor(0xE74C3C);
            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'daily') {
            const data = await getUserData(user.id);
            if (Date.now() - data.lastDaily < 86400000) return interaction.editReply("⏳ Already claimed today!");
            await addUserCoins(user.id, 25);
            db.run('UPDATE users SET lastDaily = ? WHERE userId = ?', [Date.now(), user.id]);
            const embed = new EmbedBuilder().setTitle("🎁 Daily Reward").setDescription("You received 25 coins.").setColor(0x00FF00);
            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'balance') {
            const target = options.getUser('user') || user;
            const data = await getUserData(target.id);
            const embed = new EmbedBuilder().setTitle("💰 Balance").setDescription(`User: ${target.username}\nCoins: ${data.coins}`).setColor(0x3498DB);
            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'leaderboard') {
            const scope = options.getString('scope') || 'server';
            let rows;
            if (scope === 'server' && guild) {
                rows = await dbAll(
                    'SELECT u.userId, u.coins FROM users u INNER JOIN guild_users g ON g.userId = u.userId WHERE g.guildId = ? ORDER BY u.coins DESC LIMIT 10',
                    [guild.id]
                );
            } else {
                rows = await dbAll('SELECT userId, coins FROM users ORDER BY coins DESC LIMIT 10');
            }
            const medals = ['🥇','🥈','🥉'];
            const txt = rows.map((r, i) => `${medals[i] || `**${i+1}.**`} <@${r.userId}> • ${r.coins} coins`).join('\n') || "Empty.";
            const title = scope === 'server' ? "🏆 Server Leaderboard" : "� Global Leaderboard";
            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(txt)
                .setColor(0xFFD700)
                .setFooter({ text: "Top 10 players" });
            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'questions') {
            const isAdmin = guild && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
            if (!isAdmin) return interaction.editReply("❌ Admins only.");
            const pageSize = 20;
            const total = QUIZ_POOL.length;
            const totalPages = Math.ceil(total / pageSize);
            let page = options.getInteger('page') || 1;
            if (page < 1) page = 1;
            if (page > totalPages) page = totalPages;
            const start = (page - 1) * pageSize;
            const slice = QUIZ_POOL.slice(start, start + pageSize);
            const lines = slice.map(q => `#${q.id}: ❓ ${q.question}`);
            const txt2 = lines.join('\n') || "Empty.";
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(`📚 Questions (${page}/${totalPages})`)
                        .setDescription(txt2)
                        .setColor(0x3498DB)
                        .setFooter({ text: "Admin view" })
                ]
            });
        }

        if (commandName === 'ration') {
            const stats = await getQuizStats(user.id);
            const embed = new EmbedBuilder()
                .setTitle("📊 Quiz Stats")
                .setDescription(`✅ Correct: ${stats.correct}\n❌ Wrong: ${stats.wrong}`)
                .setColor(0x9B59B6);
            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'shop') {
            const member = await guild.members.fetch(user.id);
            const data = await getUserData(user.id);
            const fields = SHOP.map(s => {
                const owned = member.roles.cache.has(s.roleId);
                const roleMention = `<@&${s.roleId}>`;
                const ownedTxt = owned ? "Already Owned" : "Not Owned";
                return {
                    name: `♟️ ${s.name}`,
                    value: `📝 Description: ${s.description}\n💰 Price: ${s.price} coins\n🎭 Role: ${roleMention}\n✅ Status: ${ownedTxt}`,
                    inline: false
                };
            });
            const embed = new EmbedBuilder()
                .setTitle(`🛒 Server Shop • Balance: ${data.coins} coins`)
                .addFields(fields)
                .setColor(0x3498DB);
            const buttons = SHOP.map(s => {
                const owned = member.roles.cache.has(s.roleId);
                const label = owned ? `Owned: ${s.name}` : `Buy ${s.name} • ${s.price} Coins`;
                return new ButtonBuilder()
                    .setCustomId(`shop_buy:${s.roleId}`)
                    .setLabel(label)
                    .setEmoji('🛒')
                    .setStyle(owned ? ButtonStyle.Secondary : ButtonStyle.Primary)
                    .setDisabled(owned);
            });
            const rows = [];
            for (let i = 0; i < buttons.length; i += 5) {
                rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
            }
            rows.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('shop_close').setLabel('Close Shop').setEmoji('🧹').setStyle(ButtonStyle.Danger)
            ));
            return interaction.editReply({ embeds: [embed], components: rows });
        }

        /* buy command removed */

        if (commandName === 'addmoney') {
            const target = options.getUser('user');
            const amount = options.getInteger('amount');
            await addUserCoins(target.id, amount);
            return interaction.editReply(`✅ Added **${amount}** coins to <@${target.id}>.`);
        }

        if (commandName === 'removemoney') {
            const target = options.getUser('user');
            const amount = options.getInteger('amount');
            await addUserCoins(target.id, -amount);
            return interaction.editReply(`✅ Removed **${amount}** coins from <@${target.id}>.`);
        }

    } catch (err) {
        console.error("Interaction Error:", err);
        await interaction.editReply("⚠️ Error occurred while processing that command.").catch(() => {});
    }
});

client.login(DISCORD_TOKEN);
