const { Client, GatewayIntentBits, ApplicationCommandOptionType, EmbedBuilder, PermissionFlagsBits, Events, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js'); 

// New Admin Permission Set: Manage Roles OR Manage Messages
const ADMIN_PERMS = PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageMessages;
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// ---------------------------
// Load token
// ---------------------------
let DISCORD_TOKEN; 
try {
    DISCORD_TOKEN = fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim();
} catch {
    console.error("CRITICAL: token.txt is missing!");
    process.exit(1);
}

// ---------------------------
// Client & Database
// ---------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const dbPath = path.join(__dirname, '..', 'data.sqlite');
const db = new sqlite3.Database(dbPath);
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
    db.run('CREATE TABLE IF NOT EXISTS guess_active (userId TEXT PRIMARY KEY, playerName TEXT NOT NULL, askedAt INTEGER NOT NULL, hintIndex INTEGER NOT NULL DEFAULT 1)');
    db.run('CREATE TABLE IF NOT EXISTS guess_cooldown (userId TEXT PRIMARY KEY, lastUsed INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS server_coins (guildId TEXT NOT NULL, userId TEXT NOT NULL, coins INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guildId, userId))');
    db.run('CREATE TABLE IF NOT EXISTS server_shop (guildId TEXT NOT NULL, itemName TEXT NOT NULL, roleId TEXT NOT NULL, price INTEGER NOT NULL, PRIMARY KEY (guildId, itemName))');
});

// ---------------------------
// DB Helpers
// ---------------------------
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(e) { e ? rej(e) : res(this); }));

const getUserData = userId => new Promise((res, rej) => {
    db.get('SELECT coins, lastDaily FROM users WHERE userId = ?', [userId], (e, r) => {
        if (e) rej(e);
        else if (!r) {
            db.run('INSERT OR IGNORE INTO users (userId, coins, lastDaily) VALUES (?,0,0)', [userId], () => res({ coins: 0, lastDaily: 0 }));
        } else res(r);
    });
});

const addUserCoins = (userId, amount, guildId = null) => new Promise((res, rej) => {
    // Always update global coins
    db.run('INSERT OR IGNORE INTO users (userId, coins) VALUES (?,0)', [userId], err => {
        if (err) return rej(err);
        db.run('UPDATE users SET coins = coins + ? WHERE userId = ?', [amount, userId], e => {
            if (e) return rej(e);
            // If guildId is provided, also update server-specific coins
            if (guildId) {
                db.run('INSERT OR IGNORE INTO server_coins (guildId, userId, coins) VALUES (?, ?, 0)', [guildId, userId], err2 => {
                    if (err2) return rej(err2);
                    db.run('UPDATE server_coins SET coins = coins + ? WHERE guildId = ? AND userId = ?', [amount, guildId, userId], e2 => e2 ? rej(e2) : res());
                });
            } else {
                res();
            }
        });
    });
});

const getServerUserData = (guildId, userId) => new Promise((res, rej) => {
    db.get('SELECT coins FROM server_coins WHERE guildId = ? AND userId = ?', [guildId, userId], (e, r) => {
        if (e) rej(e);
        else if (!r) {
            db.run('INSERT OR IGNORE INTO server_coins (guildId, userId, coins) VALUES (?, ?, 0)', [guildId, userId], () => res({ coins: 0 }));
        } else res(r);
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

const getGuessActive = userId => new Promise((res, rej) => {
    db.get('SELECT playerName, askedAt, hintIndex FROM guess_active WHERE userId = ?', [userId], (e, r) => e ? rej(e) : res(r || null));
});
const setGuessActive = (userId, playerName) => new Promise((res, rej) => {
    db.run('INSERT INTO guess_active (userId, playerName, askedAt, hintIndex) VALUES (?, ?, ?, 1) ON CONFLICT(userId) DO UPDATE SET playerName=excluded.playerName, askedAt=excluded.askedAt, hintIndex=excluded.hintIndex', [userId, playerName, Date.now()], e => e ? rej(e) : res());
});
const setGuessHintIndex = (userId, hintIndex) => new Promise((res, rej) => db.run('UPDATE guess_active SET hintIndex = ? WHERE userId = ?', [hintIndex, userId], e => e ? rej(e) : res()));
const clearGuessActive = userId => new Promise((res, rej) => db.run('DELETE FROM guess_active WHERE userId = ?', [userId], e => e ? rej(e) : res()));
const getGuessCooldown = userId => new Promise((res, rej) => db.get('SELECT lastUsed FROM guess_cooldown WHERE userId = ?', [userId], (e, r) => e ? rej(e) : res(r || null)));
const setGuessCooldown = userId => new Promise((res, rej) => db.run('INSERT INTO guess_cooldown (userId, lastUsed) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET lastUsed=excluded.lastUsed', [userId, Date.now()], e => e ? rej(e) : res()));

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
const nameTokens = s => {
    s = String(s || "").toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/[^a-z0-9\s]/g, ' ');
    const parts = s.split(/\s+/).filter(Boolean).filter(w => !STOP_WORDS.has(w));
    return new Set(parts);
};
const isNameMatch = (input, name) => {
    const a = nameTokens(name);
    const b = nameTokens(input);
    for (const t of a) { if (!b.has(t)) return false; }
    return true;
};

// ---------------------------
// Quiz Pool & Shop
// ---------------------------
const QUIZ_POOL = [
    { id: 1, type: "chess", question: "How many boxes are on the grid of doom?", answer: "64 boxes", wrong: ["32 boxes", "100 boxes"], reward: 10 },
    { id: 2, type: "chess", question: "How many people play this wooden piece war?", answer: "Two nerds", wrong: ["One nerd", "Four nerds"], reward: 10 },
    { id: 3, type: "chess", question: "Which color moves first in the early game scramble?", answer: "White", wrong: ["Black", "Random"], reward: 10 },
    { id: 4, type: "chess", question: "How many sacrifice guys (pawns) per nerd?", answer: "Eight guys", wrong: ["Six guys", "Ten guys"], reward: 10 },
    { id: 5, type: "chess", question: "What piece is the boss's boss?", answer: "Queen", wrong: ["Big boss", "The castle thing"], reward: 10 },
    { id: 6, type: "chess", question: "What piece moves in an L-shape (the horse)?", answer: "The horse", wrong: ["The pointy dude", "The castle thing"], reward: 10 },
    { id: 7, type: "chess", question: "What piece moves diagonally only (the pointy dude)?", answer: "The pointy dude", wrong: ["The castle thing", "Sacrifice guy"], reward: 10 },
    { id: 8, type: "chess", question: "What piece moves horizontally and vertically (the castle thing)?", answer: "The castle thing", wrong: ["The pointy dude", "The horse"], reward: 10 },
    { id: 9, type: "chess", question: "What piece can do the king hideaway (castle)?", answer: "The big boss", wrong: ["Boss's boss", "The horse"], reward: 10 },
    { id: 10, type: "chess", question: "What ends the game immediately (total annihilation)?", answer: "Game over", wrong: ["Awkward tie", "Time out"], reward: 10 },
    { id: 11, type: "chess", question: "What is it called when the big boss is threatened?", answer: "Check", wrong: ["Boss captured", "Guy lost"], reward: 10 },
    { id: 12, type: "chess", question: "What is the way of winning this war?", answer: "Total annihilation", wrong: ["Capturing all guys", "Reaching last rank"], reward: 10 },
    { id: 13, type: "chess", question: "What is a draw by doing the same thing 3 times?", answer: "Boring repetition", wrong: ["Awkward tie", "Draw offer"], reward: 10 },
    { id: 14, type: "chess", question: "What is it called when you can't move but aren't threatened?", answer: "Awkward tie", wrong: ["Total annihilation", "Check"], reward: 10 },
    { id: 15, type: "chess", question: "What is it called when the big boss is attacked?", answer: "Check", wrong: ["Total annihilation", "Awkward tie"], reward: 10 },
    { id: 16, type: "chess", question: "How many vertical lines (files) are there?", answer: "Eight lines", wrong: ["Six lines", "Ten lines"], reward: 10 },
    { id: 17, type: "chess", question: "How many horizontal lines (ranks) are there?", answer: "Eight lines", wrong: ["Six lines", "Ten lines"], reward: 10 },
    { id: 18, type: "chess", question: "What box does the white big boss start on?", answer: "e1 box", wrong: ["d1 box", "e2 box"], reward: 10 },
    { id: 19, type: "chess", question: "What box does the black big boss start on?", answer: "e8 box", wrong: ["d8 box", "e7 box"], reward: 10 },
    { id: 20, type: "chess", question: "How many big bosses are on the grid?", answer: "Two bosses", wrong: ["One boss", "Four bosses"], reward: 10 },
    { id: 21, type: "chess", question: "What piece cannot be captured?", answer: "The big boss", wrong: ["Boss's boss", "Sacrifice guy"], reward: 10 },
    { id: 22, type: "chess", question: "What is the king hideaway?", answer: "Boss safety", wrong: ["Guy move", "Piece capture"], reward: 10 },
    { id: 23, type: "chess", question: "What notation do nerd lords use?", answer: "Nerd code", wrong: ["Old code", "Binary code"], reward: 10 },
    { id: 24, type: "chess", question: "What is the French cheat code (en passant)?", answer: "Guy capture", wrong: ["Hideaway", "Leveling up"], reward: 10 },
    { id: 25, type: "chess", question: "What is leveling up (promotion)?", answer: "New piece", wrong: ["Hideaway", "Total annihilation"], reward: 10 },
    { id: 26, type: "chess", question: "When can leveling up happen?", answer: "Last rank", wrong: ["Middle rank", "First rank"], reward: 10 },
    { id: 27, type: "chess", question: "What is the early game scramble?", answer: "Game start", wrong: ["Game end", "Main fight"], reward: 10 },
    { id: 28, type: "chess", question: "What is the chaos phase (middlegame)?", answer: "Main phase", wrong: ["Start", "Finish"], reward: 10 },
    { id: 29, type: "chess", question: "What is the initial setup called?", answer: "Starting line", wrong: ["Finish line", "Total annihilation"], reward: 10 },
    { id: 30, type: "chess", question: "What is the cleanup crew phase (endgame)?", answer: "Few pieces", wrong: ["Many pieces", "Start"], reward: 10 },
    { id: 31, type: "chess", question: "What is a double poke (fork)?", answer: "Double attack", wrong: ["Single attack", "Defense"], reward: 10 },
    { id: 32, type: "chess", question: "What is being stuck in place (pin)?", answer: "Restricted piece", wrong: ["Free piece", "Jumping piece"], reward: 10 },
    { id: 33, type: "chess", question: "What is a kebab move (skewer)?", answer: "Reverse pin", wrong: ["Double poke", "Sacrifice"], reward: 10 },
    { id: 34, type: "chess", question: "What happens when a guy reaches the last rank?", answer: "Leveling up", wrong: ["Hideaway", "Awkward tie"], reward: 10 },
    { id: 35, type: "chess", question: "What is a bad luck move (zugzwang)?", answer: "Forced move", wrong: ["Free move", "No move"], reward: 10 },
    { id: 36, type: "chess", question: "What is risky business (gambit)?", answer: "Guy sacrifice", reward: 10, wrong: ["Piece trade", "Blunder"] },
    { id: 37, type: "chess", question: "What is a runner (passed pawn)?", answer: "No blockers", reward: 10, wrong: ["Captured guy", "Blocked guy"] },
    { id: 38, type: "chess", question: "What piece can jump others?", answer: "The horse", reward: 10, wrong: ["The castle thing", "The pointy dude"] },
    { id: 39, type: "chess", question: "What is a surprise attack (discovered)?", answer: "Hidden attack", reward: 10, wrong: ["Direct attack", "Blunder"] },
    { id: 40, type: "chess", question: "What is fancy cornering (fianchetto)?", answer: "Pointy dude move", reward: 10, wrong: ["Boss move", "Guy storm"] },
    { id: 41, type: "chess", question: "What is total annihilation protection called?", answer: "Boss defense", reward: 10, wrong: ["Attacking", "Trading"] },
    { id: 42, type: "chess", question: "What is illegal to ignore?", answer: "Check", reward: 10, wrong: ["Trade", "Guy move"] },
    { id: 43, type: "chess", question: "What is a draw by high-fiving (agreement)?", answer: "Mutual draw", reward: 10, wrong: ["Forced draw", "Win"] },
    { id: 44, type: "chess", question: "What is the Nerd Council?", answer: "World game federation", reward: 10, wrong: ["Free games", "Football federation"] },
    { id: 45, type: "chess", question: "What is speedy thinking (blitz)?", answer: "Fast game", reward: 10, wrong: ["Slow game", "Classical"] },
    { id: 46, type: "chess", question: "What is insane speed (bullet)?", answer: "Very fast", reward: 10, wrong: ["Rapid", "Slow"] },
    { id: 47, type: "chess", question: "How many points is a boss's boss worth?", answer: "Nine points", reward: 10, wrong: ["Five points", "Ten points"] },
    { id: 48, type: "chess", question: "How many points is a castle thing worth?", answer: "Five points", reward: 10, wrong: ["Three points", "Nine points"] },
    { id: 49, type: "chess", question: "How many points is a pointy dude worth?", answer: "Three points", reward: 10, wrong: ["Five points", "One point"] },
    { id: 50, type: "chess", question: "Who is the top nerd (2024)?", answer: "Ding Liren", reward: 10, wrong: ["Magnus Carlsen", "Hikaru Nakamura"] },
    { id: 51, type: "football", question: "How many players per team?", answer: "Eleven players", reward: 10, wrong: ["Seven players", "Fifteen players"] },
    { id: 52, type: "football", question: "How long is a match?", answer: "Ninety minutes", reward: 10, wrong: ["Sixty minutes", "Eighty minutes"] },
    { id: 53, type: "football", question: "How many halves are played?", answer: "Two halves", reward: 10, wrong: ["Four quarters", "Three periods"] },
    { id: 54, type: "football", question: "What restarts play after a goal?", answer: "Kick-off", reward: 10, wrong: ["Throw-in", "Corner kick"] },
    { id: 55, type: "football", question: "What card means warning?", answer: "Yellow card", reward: 10, wrong: ["Red card", "Green card"] },
    { id: 56, type: "football", question: "What card means sent off?", answer: "Red card", reward: 10, wrong: ["Yellow card", "Blue card"] },
    { id: 57, type: "football", question: "Who can use hands?", answer: "Goalkeeper only", reward: 10, wrong: ["Striker", "Everyone"] },
    { id: 58, type: "football", question: "Where can the goalkeeper use hands?", answer: "Penalty area", reward: 10, wrong: ["Whole pitch", "Halfway line"] },
    { id: 59, type: "football", question: "How many points for a win?", answer: "Three points", reward: 10, wrong: ["One point", "Five points"] },
    { id: 60, type: "football", question: "How many points for a draw?", answer: "One point", reward: 10, wrong: ["Three points", "Zero points"] },
    { id: 61, type: "football", question: "How many points for a loss?", answer: "Zero points", reward: 10, wrong: ["One point", "Three points"] },
    { id: 62, type: "football", question: "What restarts play from sideline?", answer: "Throw-in", reward: 10, wrong: ["Corner kick", "Goal kick"] },
    { id: 63, type: "football", question: "What restarts play from corner?", answer: "Corner kick", reward: 10, wrong: ["Goal kick", "Penalty"] },
    { id: 64, type: "football", question: "How do you win a league?", answer: "Most points", reward: 10, wrong: ["Most goals", "Most fans"] },
    { id: 65, type: "football", question: "How do you draw a match?", answer: "Equal score", reward: 10, wrong: ["Winning by one", "Losing by one"] },
    { id: 66, type: "football", question: "What competition decides world champion?", answer: "World Cup", reward: 10, wrong: ["Champions League", "Euros"] },
    { id: 67, type: "football", question: "How often is World Cup played?", answer: "Four years", reward: 10, wrong: ["Every year", "Two years"] },
    { id: 68, type: "football", question: "Who won World Cup 2022?", answer: "Argentina", reward: 10, wrong: ["France", "Brazil"] },
    { id: 69, type: "football", question: "What restarts play after foul?", answer: "Free kick", reward: 10, wrong: ["Kick-off", "Throw-in"] },
    { id: 70, type: "football", question: "What foul gives a penalty?", answer: "Box foul", reward: 10, wrong: ["Handball outside", "Offside"] },
    { id: 71, type: "football", question: "How far is penalty spot?", answer: "Eleven meters", reward: 10, wrong: ["Five meters", "Twenty meters"] },
    { id: 72, type: "football", question: "What decides tied knockout games?", answer: "Penalties", reward: 10, wrong: ["Coin toss", "First goal"] },
    { id: 73, type: "football", question: "What is offside based on?", answer: "Second defender", reward: 10, wrong: ["Goalie only", "First defender"] },
    { id: 74, type: "football", question: "What restarts play after foul outside box?", answer: "Free kick", reward: 10, wrong: ["Penalty", "Goal kick"] },
    { id: 75, type: "football", question: "Who enforces the rules?", answer: "Referee", reward: 10, wrong: ["Coach", "Captain"] },
    { id: 76, type: "football", question: "What is added time called?", answer: "Stoppage time", reward: 10, wrong: ["Overtime", "Half time"] },
    { id: 77, type: "football", question: "What league is England’s top league?", answer: "Premier League", reward: 10, wrong: ["La Liga", "Serie A"] },
    { id: 78, type: "football", question: "What league is Spain’s top league?", answer: "La Liga", reward: 10, wrong: ["Bundesliga", "Premier League"] },
    { id: 79, type: "football", question: "What league is Germany’s top league?", answer: "Bundesliga", reward: 10, wrong: ["Ligue 1", "La Liga"] },
    { id: 80, type: "football", question: "What league is Italy’s top league?", answer: "Serie A", reward: 10, wrong: ["Eredivisie", "Bundesliga"] },
    { id: 81, type: "football", question: "What competition is Champions League?", answer: "Club tournament", reward: 10, wrong: ["National team cup", "Friendly"] },
    { id: 82, type: "football", question: "What is a hat-trick?", answer: "Three goals", reward: 10, wrong: ["Two goals", "Five goals"] },
    { id: 83, type: "football", question: "What is a clean sheet?", answer: "No goals conceded", reward: 10, wrong: ["No fouls", "Winning 5-0"] },
    { id: 84, type: "football", question: "What is extra time length?", answer: "Thirty minutes", reward: 10, wrong: ["Ten minutes", "Sixty minutes"] },
    { id: 85, type: "football", question: "What happens after extra time draw?", answer: "Penalties", reward: 10, wrong: ["Draw", "Rematch"] },
    { id: 86, type: "football", question: "What restarts after goal line exit?", answer: "Goal kick", reward: 10, wrong: ["Corner kick", "Kick-off"] },
    { id: 87, type: "football", question: "What body part cannot score?", answer: "Hand arm", reward: 10, wrong: ["Head", "Knee"] },
    { id: 88, type: "football", question: "What is VAR?", answer: "Video review", reward: 10, wrong: ["Virtual assistant", "Goal line tech"] },
    { id: 89, type: "football", question: "What is a derby?", answer: "Local rivals", reward: 10, wrong: ["Final match", "Friendly"] },
    { id: 90, type: "football", question: "Who wears armband?", answer: "Team captain", reward: 10, wrong: ["Goalie", "Coach"] },
    { id: 91, type: "football", question: "What surface is played on?", answer: "Grass pitch", reward: 10, wrong: ["Sand", "Ice"] },
    { id: 92, type: "football", question: "What shape is the ball?", answer: "Spherical", reward: 10, wrong: ["Oval", "Square"] },
    { id: 93, type: "football", question: "What decides league ranking?", answer: "Points total", reward: 10, wrong: ["Goal count", "Fan votes"] },
    { id: 94, type: "football", question: "What happens after two yellows?", answer: "Red card", reward: 10, wrong: ["Warning", "Substitution"] },
    { id: 95, type: "football", question: "What is FIFA?", answer: "Football federation", reward: 10, wrong: ["Local club", "Fan group"] },
    { id: 96, type: "football", question: "What does UEFA organize?", answer: "European football", reward: 10, wrong: ["Asian football", "American football"] },
    { id: 97, type: "football", question: "What is kickoff used for?", answer: "Start play", reward: 10, wrong: ["End play", "Penalty"] },
    { id: 98, type: "football", question: "What is a volley?", answer: "Air shot", reward: 10, wrong: ["Ground pass", "Header"] },
    { id: 99, type: "football", question: "What is a nutmeg?", answer: "Between legs", reward: 10, wrong: ["Over head", "Side pass"] },
    { id: 100, type: "football", question: "How many referees on field?", answer: "One referee", reward: 10, wrong: ["Three referees", "Zero referees"] },
    { id: 101, type: "basketball", question: "How many players per team?", answer: "Five players", reward: 10, wrong: ["Seven players", "Eleven players"] },
    { id: 102, type: "basketball", question: "How many points is a free throw?", answer: "One point", reward: 10, wrong: ["Two points", "Three points"] },
    { id: 103, type: "basketball", question: "How many points is a three-pointer?", answer: "Three points", reward: 10, wrong: ["Two points", "Five points"] },
    { id: 104, type: "basketball", question: "How many points is a normal basket?", answer: "Two points", reward: 10, wrong: ["One point", "Three points"] },
    { id: 105, type: "basketball", question: "How many quarters are played?", answer: "Four quarters", reward: 10, wrong: ["Two halves", "Three periods"] },
    { id: 106, type: "basketball", question: "How long is an NBA game?", answer: "Forty-eight minutes", reward: 10, wrong: ["Ninety minutes", "Sixty minutes"] },
    { id: 107, type: "basketball", question: "How long is one NBA quarter?", answer: "Twelve minutes", reward: 10, wrong: ["Ten minutes", "Fifteen minutes"] },
    { id: 108, type: "basketball", question: "How high is the hoop?", answer: "Ten feet", reward: 10, wrong: ["Eight feet", "Twelve feet"] },
    { id: 109, type: "basketball", question: "What starts the game?", answer: "Jump ball", reward: 10, wrong: ["Kick-off", "Throw-in"] },
    { id: 110, type: "basketball", question: "What league is NBA?", answer: "US league", reward: 10, wrong: ["Global league", "Spanish league"] },
    { id: 111, type: "basketball", question: "What shape is the ball?", answer: "Spherical", reward: 10, wrong: ["Oval", "Square"] },
    { id: 112, type: "basketball", question: "What violation is traveling?", answer: "Illegal steps", reward: 10, wrong: ["Dribbling", "Fouling"] },
    { id: 113, type: "basketball", question: "What violation is double dribble?", answer: "Illegal dribble", reward: 10, wrong: ["Traveling", "Blocking"] },
    { id: 114, type: "basketball", question: "What is a slam dunk?", answer: "Power shot", reward: 10, wrong: ["Layup", "Free throw"] },
    { id: 115, type: "basketball", question: "What is a layup?", answer: "Close shot", reward: 10, wrong: ["Three-pointer", "Dunk"] },
    { id: 116, type: "basketball", question: "What gives three points?", answer: "Three-pointer", reward: 10, wrong: ["Dunk", "Layup"] },
    { id: 117, type: "basketball", question: "What line gives three points?", answer: "Three-point line", reward: 10, wrong: ["Free throw line", "Half-court line"] },
    { id: 118, type: "basketball", question: "What position handles the ball?", answer: "Point guard", reward: 10, wrong: ["Center", "Forward"] },
    { id: 119, type: "basketball", question: "What position is usually tallest?", answer: "Center", reward: 10, wrong: ["Guard", "Forward"] },
    { id: 120, type: "basketball", question: "What position scores outside shots?", answer: "Shooting guard", reward: 10, wrong: ["Center", "Small forward"] },
    { id: 121, type: "basketball", question: "What is a personal foul?", answer: "Illegal contact", reward: 10, wrong: ["Illegal dribble", "Traveling"] },
    { id: 122, type: "basketball", question: "How many fouls to foul out?", answer: "Six fouls", reward: 10, wrong: ["Five fouls", "Ten fouls"] },
    { id: 123, type: "basketball", question: "What is a rebound?", answer: "Missed shot catch", reward: 10, wrong: ["Goal", "Pass"] },
    { id: 124, type: "basketball", question: "What is an assist?", answer: "Scoring pass", reward: 10, wrong: ["Missed pass", "Goal"] },
    { id: 125, type: "basketball", question: "What is a steal?", answer: "Ball takeaway", reward: 10, wrong: ["Shot block", "Turnover"] },
    { id: 126, type: "basketball", question: "What is a block?", answer: "Shot rejection", reward: 10, wrong: ["Pass", "Steal"] },
    { id: 127, type: "basketball", question: "What limits possession time?", answer: "Shot clock", reward: 10, wrong: ["Game clock", "Referee"] },
    { id: 128, type: "basketball", question: "Shot clock length NBA?", answer: "Twenty-four seconds", reward: 10, wrong: ["Thirty seconds", "Ten seconds"] },
    { id: 129, type: "basketball", question: "What is goaltending?", answer: "Illegal block", reward: 10, wrong: ["Legal block", "Turnover"] },
    { id: 130, type: "basketball", question: "What is a turnover?", answer: "Lost possession", reward: 10, wrong: ["Goal", "Steal"] },
    { id: 131, type: "basketball", question: "What is overtime?", answer: "Extra time", reward: 10, wrong: ["Halftime", "Pause"] },
    { id: 132, type: "basketball", question: "Overtime length NBA?", answer: "Five minutes", reward: 10, wrong: ["Ten minutes", "Two minutes"] },
    { id: 133, type: "basketball", question: "What is a fast break?", answer: "Quick attack", reward: 10, wrong: ["Slow play", "Defense"] },
    { id: 134, type: "basketball", question: "What is zone defense?", answer: "Area defense", reward: 10, wrong: ["Man-to-man", "Full court"] },
    { id: 135, type: "basketball", question: "What is man-to-man defense?", answer: "Player marking", reward: 10, wrong: ["Zone defense", "Area defense"] },
    { id: 136, type: "basketball", question: "What surface is played on?", answer: "Hardwood court", reward: 10, wrong: ["Grass", "Concrete"] },
    { id: 137, type: "basketball", question: "What is an alley-oop?", answer: "Pass dunk", reward: 10, wrong: ["Layup", "Free throw"] },
    { id: 138, type: "basketball", question: "What is a buzzer beater?", answer: "Last shot", reward: 10, wrong: ["First shot", "Free throw"] },
    { id: 139, type: "basketball", question: "What does NBA stand for?", answer: "National Basketball Association", reward: 10, wrong: ["New Basketball Arena", "National Baller Agency"] },
    { id: 140, type: "basketball", question: "What is a field goal?", answer: "Non free-throw", reward: 10, wrong: ["Dunk only", "Three-pointer only"] },
    { id: 141, type: "basketball", question: "What stops the game?", answer: "Referee whistle", reward: 10, wrong: ["Fan noise", "Player shout"] },
    { id: 142, type: "basketball", question: "What is backcourt violation?", answer: "Half-court return", reward: 10, wrong: ["Traveling", "Double dribble"] },
    { id: 143, type: "basketball", question: "What is a crossover?", answer: "Dribble move", reward: 10, wrong: ["Shot move", "Pass move"] },
    { id: 144, type: "basketball", question: "What decides tied games?", answer: "Overtime", reward: 10, wrong: ["Draw", "Coin toss"] },
    { id: 145, type: "basketball", question: "What is a jump shot?", answer: "Shooting jump", reward: 10, wrong: ["Layup", "Dunk"] },
    { id: 146, type: "basketball", question: "What is a bench player?", answer: "Substitute", reward: 10, wrong: ["Starter", "Coach"] },
    { id: 147, type: "basketball", question: "What is possession arrow?", answer: "Tie-break rule", reward: 10, wrong: ["Jump ball", "Referee call"] },
    { id: 148, type: "basketball", question: "What is a timeout?", answer: "Game pause", reward: 10, wrong: ["Quarter end", "Foul"] },
    { id: 149, type: "basketball", question: "What jersey number is Jordan known for?", answer: "Number 23", reward: 10, wrong: ["Number 45", "Number 33"] },
    { id: 150, type: "basketball", question: "Which team has most NBA titles?", answer: "Boston Celtics", reward: 10, wrong: ["LA Lakers", "Chicago Bulls"] },

    // --- CHESS (151-200) ---
    { id: 151, type: "chess", question: "What is a 'mega oopsie'?", answer: "A terrible move", reward: 10, wrong: ["A brilliant sacrifice", "A type of early scramble"] },
    { id: 152, type: "chess", question: "Which piece is often called a 'horse' by noobs?", answer: "The horse", reward: 10, wrong: ["Pointy dude", "Castle thing"] },
    { id: 153, type: "chess", question: "What is the '4-move annihilation'?", answer: "Quick game over", reward: 10, wrong: ["A 100-move draw", "A specific early scramble"] },
    { id: 154, type: "chess", question: "What is a 'nerd lord'?", answer: "Highest game title", reward: 10, wrong: ["A game coach", "A player who never loses"] },
    { id: 155, type: "chess", question: "What does it mean to 'admit defeat'?", answer: "To give up", reward: 10, wrong: ["To offer a draw", "To pause the game"] },
    { id: 156, type: "chess", question: "Which piece cannot move backwards?", answer: "Sacrifice guy", reward: 10, wrong: ["The horse", "Big boss"] },
    { id: 157, type: "chess", question: "What is a 'brilliant' move?", answer: "Best sacrifice", reward: 10, wrong: ["A random move", "Capturing a little guy"] },
    { id: 158, type: "chess", question: "What is 'bullet' game time control?", answer: "1 minute or less", reward: 10, wrong: ["10 minutes", "1 hour"] },
    { id: 159, type: "chess", question: "What is 'speed' gaming called?", answer: "Blitz", reward: 10, wrong: ["Slow", "Turtling"] },
    { id: 160, type: "chess", question: "What is a 'nerd score'?", answer: "Skill level number", reward: 10, wrong: ["Number of wins", "Age of player"] },
    { id: 161, type: "chess", question: "Who is 'Magnus Carlsen'?", answer: "The goat nerd lord", reward: 10, wrong: ["A ball kicker", "A wooden piece"] },
    { id: 162, type: "chess", question: "What is the 'Sicilian Defense'?", answer: "A popular early scramble", reward: 10, wrong: ["A type of annihilation", "A defensive wall"] },
    { id: 163, type: "chess", question: "What is the 'French cheat code'?", answer: "Little guy capture rule", reward: 10, wrong: ["A fancy dance", "A way to draw"] },
    { id: 164, type: "chess", question: "What is an 'awkward tie'?", answer: "A type of draw", reward: 10, wrong: ["A win for white", "A loss for black"] },
    { id: 165, type: "chess", question: "What is 'king hideaway'?", answer: "Big boss & castle thing move", reward: 10, wrong: ["Boss's boss & big boss move", "Two castle thing swap"] },
    { id: 166, type: "chess", question: "What is a 'fork' in this game?", answer: "Attacking two pieces", reward: 10, wrong: ["Eating lunch", "Trading boss's bosses"] },
    { id: 167, type: "chess", question: "What is a 'pin'?", answer: "Trapping a piece", reward: 10, wrong: ["Winning a little guy", "Using a clock"] },
    { id: 168, type: "chess", question: "What is a 'skewer'?", answer: "Attacking through", reward: 10, wrong: ["Losing a horse", "A type of board"] },
    { id: 169, type: "chess", question: "What is 'chaos phase'?", answer: "Phase after early scramble", reward: 10, wrong: ["The very end", "The first move"] },
    { id: 170, type: "chess", question: "What is 'cleanup crew phase'?", answer: "Few pieces left", reward: 10, wrong: ["Start of game", "A Marvel movie"] },
    { id: 171, type: "chess", question: "What is a 'sac'?", answer: "Short for sacrifice", reward: 10, wrong: ["A bag of pieces", "A type of move"] },
    { id: 172, type: "chess", question: "What is 'scramble theory'?", answer: "Studied first moves", reward: 10, wrong: ["Guessing moves", "A science class"] },
    { id: 173, type: "chess", question: "What is 'Nerd Points'?", answer: "Rating system", reward: 10, wrong: ["Electric Light Orchestra", "A player name"] },
    { id: 174, type: "chess", question: "What is a 'candidate'?", answer: "Player in qualifiers", reward: 10, wrong: ["A beginner", "A wooden piece"] },
    { id: 175, type: "chess", question: "What is the 'London System'?", answer: "A solid early scramble", reward: 10, wrong: ["A city train", "A type of clock"] },
    { id: 176, type: "chess", question: "What is a 'fianchetto'?", answer: "Pointy dude on long diagonal", reward: 10, wrong: ["A small little guy", "A type of pasta"] },
    { id: 177, type: "chess", question: "What is 'mating' in this game?", answer: "Delivering total annihilation", reward: 10, wrong: ["Finding a partner", "Trading pieces"] },
    { id: 178, type: "chess", question: "What is a 'double poke'?", answer: "Two pieces attacking", reward: 10, wrong: ["Checking twice", "A safe move"] },
    { id: 179, type: "chess", question: "What is 'underpromotion'?", answer: "Leveling up to non-boss's boss", reward: 10, wrong: ["Losing a little guy", "Leveling up late"] },
    { id: 180, type: "chess", question: "What is a 'nerd lord draw'?", answer: "A quick boring draw", reward: 10, wrong: ["A brilliant win", "A 100-move fight"] },
    { id: 181, type: "chess", question: "What is 'tilting'?", answer: "Playing worse due to anger", reward: 10, wrong: ["Moving the board", "A winning streak"] },
    { id: 182, type: "chess", question: "What is a 'smothered annihilation'?", answer: "Annihilation by a horse", reward: 10, wrong: ["Annihilation by a boss's boss", "Annihilation with no pieces"] },
    { id: 183, type: "chess", question: "What is a 'back rank annihilation'?", answer: "Annihilation on the 1st/8th rank", reward: 10, wrong: ["Annihilation from behind", "Annihilation with a little guy"] },
    { id: 184, type: "chess", question: "What is an 'aggressive' player?", answer: "Tricky nerd", reward: 10, wrong: ["Slow & boring", "Defensive only"] },
    { id: 185, type: "chess", question: "What is a 'positional' player?", answer: "Strategic & slow", reward: 10, wrong: ["Wild & crazy", "Fastest player"] },
    { id: 186, type: "chess", question: "What is the 'Queen's Gambit'?", answer: "Sacrificing a little guy", reward: 10, wrong: ["A Netflix show only", "A boss's boss trade"] },
    { id: 187, type: "chess", question: "What is 'time pressure'?", answer: "Low time on clock", reward: 10, wrong: ["Pushing the clock", "Being nervous"] },
    { id: 188, type: "chess", question: "What is a 'game engine'?", answer: "AI that plays the game", reward: 10, wrong: ["A car part", "A physical clock"] },
    { id: 189, type: "chess", question: "What is 'Stockfish'?", answer: "The best game AI", reward: 10, wrong: ["A type of meal", "A player name"] },
    { id: 190, type: "chess", question: "What is a 'premove'?", answer: "Moving before turn", reward: 10, wrong: ["Thinking fast", "Moving twice"] },
    { id: 191, type: "chess", question: "What is 'hypermodern' gaming?", answer: "Controlling center from afar", reward: 10, wrong: ["Modern board design", "Playing very fast"] },
    { id: 192, type: "chess", question: "What is 'classical' gaming?", answer: "Long time controls", reward: 10, wrong: ["Old board sets", "Boring games"] },
    { id: 193, type: "chess", question: "What is the 'French Defense'?", answer: "Solid e6 early scramble", reward: 10, wrong: ["A type of surrender", "A hideaway move"] },
    { id: 194, type: "chess", question: "What is a 'discovered poke'?", answer: "Moving to reveal poke", reward: 10, wrong: ["Finding a poke", "Poking twice"] },
    { id: 195, type: "chess", question: "What is a 'zwischenzug'?", answer: "An in-between move", reward: 10, wrong: ["A type of piece", "A German player"] },
    { id: 196, type: "chess", question: "What is 'perpetual poke'?", answer: "Endless pokes (draw)", reward: 10, wrong: ["A winning poke", "A hidden poke"] },
    { id: 197, type: "chess", question: "What is a 'runner'?", answer: "No enemy little guys ahead", reward: 10, wrong: ["A guy that died", "A traded guy"] },
    { id: 198, type: "chess", question: "What is 'opposition' in this game?", answer: "Big bosses facing each other", reward: 10, wrong: ["The other player", "A type of attack"] },
    { id: 199, type: "chess", question: "What is a 'bad pointy dude'?", answer: "Blocked by own little guys", reward: 10, wrong: ["A pointy dude that blunders", "A mean player"] },
    { id: 200, type: "chess", question: "What is 'the exchange'?", answer: "Trading minor for major piece", reward: 10, wrong: ["Trading boss's bosses", "Trading places"] },

    // --- FOOTBALL (201-250) ---
    { id: 201, type: "football", question: "Who has the most Ballon d'Ors?", answer: "Lionel Messi", reward: 10, wrong: ["Cristiano Ronaldo", "Pele"] },
    { id: 202, type: "football", question: "What is a 'clean sheet'?", answer: "Zero goals conceded", reward: 10, wrong: ["A new jersey", "Winning 1-0"] },
    { id: 203, type: "football", question: "What is ' Fergie Time'?", answer: "Late winning goals", reward: 10, wrong: ["Time to eat", "A type of sub"] },
    { id: 204, type: "football", question: "Which club has most UCLs?", answer: "Real Madrid", reward: 10, wrong: ["AC Milan", "Liverpool"] },
    { id: 205, type: "football", question: "What is a 'Panenka'?", answer: "A chipped penalty", reward: 10, wrong: ["A type of foul", "A stadium name"] },
    { id: 206, type: "football", question: "Who is the 'Special One'?", answer: "Jose Mourinho", reward: 10, wrong: ["Pep Guardiola", "Jurgen Klopp"] },
    { id: 207, type: "football", question: "What is 'tiki-taka'?", answer: "Short passing style", reward: 10, wrong: ["A brand of candy", "A defensive wall"] },
    { id: 208, type: "football", question: "What is a 'nutmeg'?", answer: "Ball between legs", reward: 10, wrong: ["A type of spice", "A header goal"] },
    { id: 209, type: "football", question: "Which country won 2014 WC?", answer: "Germany", reward: 10, wrong: ["Argentina", "Brazil"] },
    { id: 210, type: "football", question: "What is 'parking the bus'?", answer: "Ultra-defensive play", reward: 10, wrong: ["Driving to game", "Buying players"] },
    { id: 211, type: "football", question: "Who scored the 'Hand of God'?", answer: "Diego Maradona", reward: 10, wrong: ["Pele", "Messi"] },
    { id: 212, type: "football", question: "What is a 'hat-trick'?", answer: "3 goals in a game", reward: 10, wrong: ["2 goals", "Winning 3-0"] },
    { id: 213, type: "football", question: "Which league is 'La Liga'?", answer: "Spanish League", reward: 10, wrong: ["English League", "Italian League"] },
    { id: 214, type: "football", question: "What is 'El Clasico'?", answer: "Real Madrid vs Barca", reward: 10, wrong: ["Milan vs Inter", "Liverpool vs Utd"] },
    { id: 215, type: "football", question: "Who is the all-time top scorer?", answer: "Cristiano Ronaldo", reward: 10, wrong: ["Lionel Messi", "Pele"] },
    { id: 216, type: "football", question: "What is a 'brace'?", answer: "2 goals in a game", reward: 10, wrong: ["3 goals", "A dental tool"] },
    { id: 217, type: "football", question: "What is the 'Golden Boot'?", answer: "Top scorer award", reward: 10, wrong: ["Best goalie award", "Most fouls award"] },
    { id: 218, type: "football", question: "Who is 'Zlatan'?", answer: "A god (self-proclaimed)", reward: 10, wrong: ["A normal player", "A coach"] },
    { id: 219, type: "football", question: "What is a 'tackle'?", answer: "Stealing the ball", reward: 10, wrong: ["Hitting a player", "A type of pass"] },
    { id: 220, type: "football", question: "What is 'offside'?", answer: "Being behind defenders", reward: 10, wrong: ["Outside the pitch", "Touching the ball"] },
    { id: 221, type: "football", question: "What is 'VAR'?", answer: "Video review system", reward: 10, wrong: ["A type of ball", "Virtual reality"] },
    { id: 222, type: "football", question: "Which club is 'The Blues'?", answer: "Chelsea", reward: 10, wrong: ["Man City", "Everton"] },
    { id: 223, type: "football", question: "Which club is 'The Red Devils'?", answer: "Manchester United", reward: 10, wrong: ["Liverpool", "Arsenal"] },
    { id: 224, type: "football", question: "What is a 'clean' tackle?", answer: "Touching ball first", reward: 10, wrong: ["No grass stains", "A soft touch"] },
    { id: 225, type: "football", question: "What is a 'tap-in'?", answer: "Easy close-range goal", reward: 10, wrong: ["A long shot", "A header"] },
    { id: 226, type: "football", question: "Who is 'Neymar'?", answer: "Brazilian skill star", reward: 10, wrong: ["A French goalie", "A referee"] },
    { id: 227, type: "football", question: "What is 'Injury Time'?", answer: "Extra time at end", reward: 10, wrong: ["Time to heal", "Half time"] },
    { id: 228, type: "football", question: "What is a 'bicycle kick'?", answer: "Overhead shot", reward: 10, wrong: ["Kicking a bike", "A low shot"] },
    { id: 229, type: "football", question: "What is 'The Invincibles'?", answer: "Arsenal 03/04", reward: 10, wrong: ["Man City 2023", "Real Madrid 2017"] },
    { id: 230, type: "football", question: "Who is 'Kylian Mbappe'?", answer: "French speedster", reward: 10, wrong: ["An old legend", "A goalie"] },
    { id: 231, type: "football", question: "What is a 'corner'?", answer: "Kick from corner flag", reward: 10, wrong: ["A type of foul", "A throw-in"] },
    { id: 232, type: "football", question: "What is a 'goal-line' tech?", answer: "Checks if ball in", reward: 10, wrong: ["A type of VAR", "A camera only"] },
    { id: 233, type: "football", question: "Who is 'Erling Haaland'?", answer: "Norwegian goal bot", reward: 10, wrong: ["A Swedish defender", "A coach"] },
    { id: 234, type: "football", question: "What is 'Gegenpressing'?", answer: "Heavy metal football", reward: 10, wrong: ["Slow passing", "Parking the bus"] },
    { id: 235, type: "football", question: "What is a 'relegation'?", answer: "Moving down a league", reward: 10, wrong: ["Winning the cup", "Retiring"] },
    { id: 236, type: "football", question: "What is 'promotion'?", answer: "Moving up a league", reward: 10, wrong: ["Getting a raise", "Winning a game"] },
    { id: 237, type: "football", question: "Who is 'Luka Modric'?", answer: "Croatian midfield maestro", reward: 10, wrong: ["A striker", "A defender"] },
    { id: 238, type: "football", question: "What is a 'wall'?", answer: "Players blocking freekick", reward: 10, wrong: ["A brick structure", "The goalie only"] },
    { id: 239, type: "football", question: "What is 'diving'?", answer: "Faking a foul", reward: 10, wrong: ["Swimming", "A header"] },
    { id: 240, type: "football", question: "What is 'The Treble'?", answer: "3 major trophies", reward: 10, wrong: ["3 goals", "Winning 3 games"] },
    { id: 241, type: "football", question: "Who is 'Harry Kane'?", answer: "English goal machine", reward: 10, wrong: ["A goalie", "A German defender"] },
    { id: 242, type: "football", question: "What is 'Anfield'?", answer: "Liverpool's stadium", reward: 10, wrong: ["Man Utd's stadium", "A player"] },
    { id: 243, type: "football", question: "What is 'Old Trafford'?", answer: "Man Utd's stadium", reward: 10, wrong: ["A museum", "Liverpool's ground"] },
    { id: 244, type: "football", question: "What is a 'scorpian kick'?", answer: "Heel kick over head", reward: 10, wrong: ["A low kick", "A bug's move"] },
    { id: 245, type: "football", question: "Who is 'Robert Lewandowski'?", answer: "Polish striker", reward: 10, wrong: ["A German goalie", "A coach"] },
    { id: 246, type: "football", question: "What is a 'transfer window'?", answer: "Time to buy players", reward: 10, wrong: ["A literal window", "End of season"] },
    { id: 247, type: "football", question: "What is 'The FA Cup'?", answer: "English knockout cup", reward: 10, wrong: ["The Premier League", "A friendly cup"] },
    { id: 248, type: "football", question: "Who is 'Vinicius Jr'?", answer: "Real Madrid star", reward: 10, wrong: ["A Barca legend", "A goalie"] },
    { id: 249, type: "football", question: "What is 'The Ballon d'Or'?", answer: "Best player award", reward: 10, wrong: ["Best goal award", "A gold ball"] },
    { id: 250, type: "football", question: "What is a 'screamer'?", answer: "A long-range banger", reward: 10, wrong: ["A loud fan", "A foul"] },

    // --- BASKETBALL (251-300) ---
    { id: 251, type: "basketball", question: "Who is the 'King'?", answer: "LeBron James", reward: 10, wrong: ["Michael Jordan", "Steph Curry"] },
    { id: 252, type: "basketball", question: "What is a 'triple-double'?", answer: "10+ in 3 categories", reward: 10, wrong: ["30 points", "3 dunks"] },
    { id: 253, type: "basketball", question: "Who is the 'Chef'?", answer: "Steph Curry", reward: 10, wrong: ["Kevin Durant", "LeBron"] },
    { id: 254, type: "basketball", question: "What is a 'layup'?", answer: "Close-range shot", reward: 10, wrong: ["A 3-pointer", "A dunk"] },
    { id: 255, type: "basketball", question: "What is 'The Finals'?", answer: "Championship series", reward: 10, wrong: ["Last game of season", "The playoffs"] },
    { id: 256, type: "basketball", question: "Who is 'Giannis'?", answer: "The Greek Freak", reward: 10, wrong: ["The Italian Stallion", "The Big Man"] },
    { id: 257, type: "basketball", question: "What is a 'swish'?", answer: "Ball hitting only net", reward: 10, wrong: ["Ball hitting rim", "A missed shot"] },
    { id: 258, type: "basketball", question: "What is 'March Madness'?", answer: "College tournament", reward: 10, wrong: ["NBA playoffs", "Angry players"] },
    { id: 259, type: "basketball", question: "Who is 'KD'?", answer: "Kevin Durant", reward: 10, wrong: ["Kyrie Durant", "Klay Durant"] },
    { id: 260, type: "basketball", question: "What is a 'technical' foul?", answer: "Unsportsmanlike act", reward: 10, wrong: ["Hitting a player", "Traveling"] },
    { id: 261, type: "basketball", question: "Who is 'The Joker'?", answer: "Nikola Jokic", reward: 10, wrong: ["LeBron", "Luka"] },
    { id: 262, type: "basketball", question: "What is a 'fadeaway'?", answer: "Jumping backwards", reward: 10, wrong: ["Jumping forward", "Falling down"] },
    { id: 263, type: "basketball", question: "Who is 'Luka Magic'?", answer: "Luka Doncic", reward: 10, wrong: ["Luka Modric", "Luka S."] },
    { id: 264, type: "basketball", question: "What is 'and-one'?", answer: "Fouled while scoring", reward: 10, wrong: ["A brand of shoes", "Getting 2 points"] },
    { id: 265, type: "basketball", question: "Who is 'Dame Time'?", answer: "Damian Lillard", reward: 10, wrong: ["Stephen Curry", "Kyrie"] },
    { id: 266, type: "basketball", question: "What is a 'double-double'?", answer: "10+ in 2 categories", reward: 10, wrong: ["20 points", "2 dunks"] },
    { id: 267, type: "basketball", question: "What is 'the paint'?", answer: "Area near hoop", reward: 10, wrong: ["Literal paint", "Outside 3-point line"] },
    { id: 268, type: "basketball", question: "Who is 'The Beard'?", answer: "James Harden", reward: 10, wrong: ["Anthony Davis", "LeBron"] },
    { id: 269, type: "basketball", question: "What is a 'brick'?", answer: "A very bad miss", reward: 10, wrong: ["A solid player", "A type of ball"] },
    { id: 270, type: "basketball", question: "Who is 'Kyrie'?", answer: "The handles master", reward: 10, wrong: ["A goalie", "A dunker"] },
    { id: 271, type: "basketball", question: "What is 'downtime'?", answer: "Rest between quarters", reward: 10, wrong: ["Time to dunk", "Half time"] },
    { id: 272, type: "basketball", question: "What is a 'poster'?", answer: "Dunking on someone", reward: 10, wrong: ["A wall decoration", "A 3-pointer"] },
    { id: 273, type: "basketball", question: "Who is 'AD'?", answer: "Anthony Davis", reward: 10, wrong: ["Andre Drummond", "Alexuso"] },
    { id: 274, type: "basketball", question: "What is a 'steal'?", answer: "Taking the ball away", reward: 10, wrong: ["Cheating", "A block"] },
    { id: 275, type: "basketball", question: "What is a 'block'?", answer: "Swatting a shot", reward: 10, wrong: ["A defensive move", "A foul"] },
    { id: 276, type: "basketball", question: "Who is 'The Process'?", answer: "Joel Embiid", reward: 10, wrong: ["Ben Simmons", "Harden"] },
    { id: 277, type: "basketball", question: "What is 'clutch'?", answer: "Good in final mins", reward: 10, wrong: ["A car part", "Angry"] },
    { id: 278, type: "basketball", question: "What is 'garbage time'?", answer: "End of blowout game", reward: 10, wrong: ["Time to clean", "Pre-game"] },
    { id: 279, type: "basketball", question: "Who is 'Klay'?", answer: "The other Splash Bro", reward: 10, wrong: ["A clay model", "A coach"] },
    { id: 280, type: "basketball", question: "What is a 'dime'?", answer: "A great assist", reward: 10, wrong: ["10 points", "A small coin"] },
    { id: 281, type: "basketball", question: "Who is 'Spida'?", answer: "Donovan Mitchell", reward: 10, wrong: ["Peter Parker", "Trae Young"] },
    { id: 282, type: "basketball", question: "What is a 'flop'?", answer: "Faking contact", reward: 10, wrong: ["A missed dunk", "Falling down"] },
    { id: 283, type: "basketball", question: "Who is 'Ice Trae'?", answer: "Trae Young", reward: 10, wrong: ["An ice cube", "Luka Doncic"] },
    { id: 284, type: "basketball", question: "What is a 'fastbreak'?", answer: "Quick counter attack", reward: 10, wrong: ["Breaking fast", "A long break"] },
    { id: 285, type: "basketball", question: "Who is 'The Claw'?", answer: "Kawhi Leonard", reward: 10, wrong: ["LeBron", "A cat"] },
    { id: 286, type: "basketball", question: "What is a 'pump fake'?", answer: "Faking a shot", reward: 10, wrong: ["Pumping air", "A real shot"] },
    { id: 287, type: "basketball", question: "Who is 'Ja'?", answer: "Ja Morant", reward: 10, wrong: ["Jar Rule", "Ja Master"] },
    { id: 288, type: "basketball", question: "What is 'The Logo'?", answer: "Jerry West", reward: 10, wrong: ["Michael Jordan", "LeBron"] },
    { id: 289, type: "basketball", question: "Who is 'Zion'?", answer: "Dunking powerhouse", reward: 10, wrong: ["A mountain", "A goalie"] },
    { id: 290, type: "basketball", question: "What is 'sixth man'?", answer: "Best bench player", reward: 10, wrong: ["The referee", "A fan"] },
    { id: 291, type: "basketball", question: "Who is 'Wemby'?", answer: "Victor Wembanyama", reward: 10, wrong: ["A French bread", "A defender"] },
    { id: 292, type: "basketball", question: "What is 'box out'?", answer: "Blocking for rebound", reward: 10, wrong: ["Boxing a player", "Leaving the court"] },
    { id: 293, type: "basketball", question: "Who is 'CP3'?", answer: "Chris Paul", reward: 10, wrong: ["A robot", "Cliff Paul"] },
    { id: 294, type: "basketball", question: "What is a 'screen'?", answer: "Blocking for teammate", reward: 10, wrong: ["A TV", "A foul"] },
    { id: 295, type: "basketball", question: "Who is 'The Brow'?", answer: "Anthony Davis", reward: 10, wrong: ["James Harden", "LeBron"] },
    { id: 296, type: "basketball", question: "What is 'iso'?", answer: "One-on-one play", reward: 10, wrong: ["Isolated court", "A foul"] },
    { id: 297, type: "basketball", question: "Who is 'Bam'?", answer: "Bam Adebayo", reward: 10, wrong: ["A sound effect", "A coach"] },
    { id: 298, type: "basketball", question: "What is 'full court press'?", answer: "Defending whole court", reward: 10, wrong: ["A media event", "A long shot"] },
    { id: 299, type: "basketball", question: "Who is 'Book'?", answer: "Devin Booker", reward: 10, wrong: ["A literal book", "A goalie"] },
    { id: 300, type: "basketball", question: "What is a 'double team'?", answer: "2 players on 1", reward: 10, wrong: ["2 teams playing", "A foul"] },
];


const PLAYERS_CHESS_TEXT = `
1. Magnus Carlsen
Youngest King of the Nerds in history
Dominated slow mode, fast mode, and panic mode simultaneously
Slammed the table during a high-stakes nerd battle (2023)
Voluntarily gave up the Lord of the Grid title
Famous for squeezing wins from boring equal situations
2. Garry Kasparov
Youngest Supreme Nerd at the time
Symbol of aggressive, scary grid play
Historic matches vs a literal computer (and lost once, lol)
Ruled the nerd rankings for over 20 years
Became a professional arguer after retiring
3. Bobby Fischer
Only American to conquer the Soviet Grid Machines
Ended nerd dominance in 1972
Perfect 6–0–6 run in the Nerd Hunger Games
Extremely spicy and controversial personality
Vanished into thin air after winning the shiny trophy
4. Anatoly Karpov
Master of "don't touch my stuff" grid play
Became Lord of the Grid because the other guy didn't show up (1975)
Legendary rivalry with the aggressive guy (Kasparov)
Incredible consistency at sitting in a chair for hours
Famous for slowly suffocating opponents' hopes and dreams
5. Vladimir Kramnik
Ended the reign of the previous Nerd Boss
Popularized the "nothing is happening" defense
Deep understanding of where to put the wooden pieces
Later involved in "is he cheating?" internet drama
Elite theorist of the first 5 seconds of the game
6. Viswanathan Anand
The first Supreme Nerd from India
Extremely fast brain calculator
Lord of the Grid in three different speeds of thinking
Known for not panicking when the clock goes tick-tock
National icon for being smart
7. Hikaru Nakamura
One of the best "Speed Panic" players ever
Twitch & YouTube superstar for board game nerds
Known for moving fast and talking trash
Made a comeback in the 2022 Hunger Games
Online clicking legend
8. Fabiano Caruana
Came closest to beating the final boss Magnus (2018)
Reached a "super nerd" rating peak
Extremely precise research on the first few moves
Known for staying up all night studying wooden squares
Calm, robotic style of play
9. Ding Liren
The first Lord of the Grid from China
Famous 100+ game "you can't beat me" streak
Very quiet and humble for a top-tier nerd
Overcame serious "I don't want to play" vibes
Elite at not losing
10. Alireza Firouzja
Youngest player to reach "mega nerd" status
Switched teams from Iran to France for more freedom
Ultra-aggressive "I will fight you" style
Fashion designer because being a nerd wasn't enough
Touted as the future Ruler of the Grid
11. Mikhail Tal
“The Magician from a place called Riga”
Threw away his pieces just to cause chaos
Supreme Nerd in 1960
Pure intuition and "I hope this works" energy
Everyone's favorite chaotic neutral player
12. José Raúl Capablanca
Naturally gifted at moving wooden blocks
Minimum studying, maximum winning
Legendary technique at the end of the game
Very long "I haven't lost in years" streaks
Third Lord of the Grid
13. Emanuel Lasker
Longest-reigning Nerd Boss (27 years)
Philosopher who thought about the game too much
Psychological approach: "I'll make you uncomfortable"
Defeated multiple generations of younger nerds
Extremely practical and annoying to play against
14. Alexander Alekhine
Ferocious attacking Nerd Boss
Never lost his title in an actual fight
Has a "confuse the opponent" move named after him
Brilliant at seeing things 20 steps ahead
Tragic personal life but great at board games
15. Mikhail Botvinnik
Father of the Soviet Nerd Factory
Multiple-time Lord of the Grid
Teacher to the next generation of top nerds
Scientific approach to a game about wooden pieces
Dominated the post-war nerd scene
16. Wesley So
Known for being a very polite nerd
Elite technician of the "Final Struggle"
Olympiad champion for Team USA
Calm and disciplined "I will not make a mistake" style
Strong mental control over his own brain
17. Ian Nepomniachtchi
Multiple-time Hunger Games winner
Extremely fast at making decisions (sometimes bad ones)
Collapsed when the pressure of the shiny trophy got too high
Highly creative and unpredictable
Childhood rival of the final boss Magnus
18. Levon Aronian
One of the most liked guys in the nerd community
Creative at throwing pieces for a win
Team champion with Armenia
Known for telling jokes while winning
Universal style: can be boring or exciting
19. Sergey Karjakin
Youngest "Senior Grid Specialist" ever
Challenged for the shiny trophy in 2016
A literal brick wall of defense
Got into a lot of political arguments online
Extremely hard to knock down
20. Teimour Radjabov
Beat the Boss (Kasparov) when he was just 15
Extremely solid "nothing gets through" style
Longtime contender for the top spot
Cautious style: "safety first, winning second"
Strong comeback after a long nap
21. Paul Morphy
Greatest nerd of the 1800s
Dominated everyone across the ocean
Attacking genius before people knew how to defend
Retired early to be a lawyer (boring)
Legend who never got a formal title
22. Judit Polgár
Strongest female nerd to ever touch the grid
Beat multiple Nerd Bosses
Refused to play in the "girls only" section
Aggressive "I will crush you" style
Broke all the rules about who can be a nerd
23. Max Euwe
Mathematician who was also a Nerd Boss
Known for being a very fair player
Defeated the scary attacking guy (Alekhine)
Later became the President of all Nerds
Logical and structured approach to life
24. Boris Spassky
The gentlemanly Nerd Boss
Lost the "Cold War" match to the American guy
Can play any style: boring, exciting, or weird
Stayed out of political drama
Elegant moves on the grid
25. Veselin Topalov
Extremely aggressive "all or nothing" player
Dominated the big nerd tournament in 2005
Lord of the Grid for one year
Involved in "toiletgate" cheating drama (don't ask)
Tactical powerhouse
26. Shakhriyar Mamedyarov
Always plays for a win, never for a draw
Wild, chaotic games that make your head hurt
Fan favorite for being a madman
Explosive attacks out of nowhere
High-risk, high-reward nerd energy
27. Anish Giri
Expert at the first 10 minutes of research
Famous for making board game memes on Twitter
Extremely hard to beat, but also hard for him to win
Long "everything is a draw" streaks
Elite preparation for every scenario
28. Gukesh D
Youngest person to challenge for the shiny trophy
Beat the final boss Magnus a bunch of times
Part of the new wave of super nerds from India
Fearless even when the scary clock is ticking
Very calm for a teenager
29. Praggnanandhaa
Beat the final boss Magnus while he was still a kid
Learns new things at 2x speed
Strong brain calculator
National hero for being a prodigy
Remarkably mature for a young nerd
30. Vidit Gujrathi
Participant in the Nerd Hunger Games
Very solid and reliable player
Excellent at playing on a team
Underrated for a long time
Can play any style depending on the mood
31. Richard Rapport
Chooses weird moves just to be different
Highly creative and artistic
Known for wearing cool shirts to nerd events
Chaos-driven grid play
Artistic approach to moving wooden pieces
32. Jan-Krzysztof Duda
The guy who finally beat Magnus's win streak
Reached the final level of the World Cup
Strong at fast-paced clicking games
Fearless competitor who doesn't care who you are
Excellent at the "Final Struggle" part of the game
33. Yi Wei
Chinese elite Senior Grid Specialist
Expert at where to stand on the grid
Doesn't talk to the media much
Strong "middle of the game" skills
Very solid and hard to knock over
34. Samuel Reshevsky
Kid prodigy who grew up to be a legend
Tactical fighter who never gave up
American board game icon
Very religious, didn't play on Saturdays
Had a career that lasted approximately forever
35. Tigran Petrosian
The ultimate defensive genius
Nicknamed “Iron Tigran” because he's a wall
Sacrificed his own stuff just to stay safe
Very, very, very hard to beat
Master of "I know what you're trying to do"
36. David Bronstein
Almost became the Lord of the Grid
Thinker who came up with weird ideas
Innovator of how to play the first 5 minutes
Author of nerd books people actually read
Famous for "let's see what happens" moves
37. Bent Larsen
The hope of the Western nerds
Highly original and weird moves
Challenged the Soviet nerd dominance
Fearless attacker who didn't care about safety
Unorthodox and fun to watch
38. Peter Svidler
Expert at one specific type of defense
Top-level talker about other people's games
Multiple-time champion of his country
Known for having a great sense of humor
Elite research specialist
39. Wesley So
Multiple-time world champion of "fast clicking"
A literal machine at the end of the game
Extremely clean and boring (but winning) technique
Rarely makes a "mega oopsie"
Ice-cold nerves under pressure
40. Hou Yifan
The strongest girl nerd currently playing
Competed against the top guys regularly
Gave up being a pro nerd to be a professor
Strategic and smart style
Global role model for smart people
41. Fischer
Invented a version of the game where you shuffle the pieces
Hated when games ended too fast
Innovator of the "Early Scramble"
Perfectionist at the end of the game
Absolute "it must be perfect" mindset
42. Viktor Korchnoi
A guy who fought until he was 80 years old
Defected from his country to keep playing
Extreme willpower and grumpiness
Never became the official Lord of the Grid (sad)
Legendary mental toughness
43. Daniil Dubov
Creative assistant to the final boss Magnus
Loves throwing pieces away for fun
Modern ideas that confuse old nerds
Specialist at "Speed Panic" mode
Highly unconventional and cool
44. Arjun Erigaisi
One of the fastest rating climbs in history
Extremely aggressive "I'm coming for you" style
New-generation superstar
Fearless approach to every game
Strong at calculating scary moves
45. Nihal Sarin
Prodigy at "Speed Panic" mode
Moves so fast you can't see his hands
Online clicking monster
Tactical vision like a hawk
Very young and already at the top
46. Gata Kamsky
Reached the final level for the shiny trophy
Had a legendary "I'm back" story
Very calm and quiet personality
Solid and reliable style
Had an elite career that lasted decades
47. Alexander Grischuk
Famous for using all his time in the first 5 minutes
Elite at "Speed Panic" games
Very funny guy in interviews
Risk-taking style that makes people nervous
Massive experience at being a top nerd
48. Nodirbek Abdusattorov
World Fast-Clicking Champion (2021)
Known for having "nerves of steel"
Leading the new generation of nerds
Incredible defensive skills when he's losing
Extremely focused on the grid
49. Dommaraju Gukesh
Youngest Hunger Games winner ever
Challenged for the Lord of the Grid title
Extremely mature for a teenager
Part of the golden era of Indian nerds
Incredible calculation speed
50. Rameshbabu Praggnanandhaa
Broke into the elite level while still a kid
Known for studying the game 24/7
Beat the boss Magnus multiple times in fast mode
Won a gold medal for his country
Incredible at the "Final Struggle"
`;

const PLAYERS_FOOTBALL_TEXT = `
1. Lionel Messi
8 Ballon d'Or awards
Won the 2022 World Cup with Argentina
Spent most of his career at FC Barcelona
Often called "La Pulga"
Known for incredible dribbling and playmaking
2. Cristiano Ronaldo
All-time leading goalscorer in international football
Won 5 Champions League titles
Played for Man Utd, Real Madrid, Juventus, Al-Nassr
Famous for his "Siuuu" celebration
Incredible athleticism and work ethic
3. Pele
Only player to win 3 World Cups
Scored over 1000 goals in his career
Brazilian legend who played for Santos
Named "Athlete of the Century"
Global ambassador for football
4. Diego Maradona
Scored the "Hand of God" goal
Led Argentina to 1986 World Cup victory
Legendary status at Napoli
One of the greatest dribblers ever
Known for the "Goal of the Century"
5. Zinedine Zidane
Scored twice in the 1998 World Cup final
Famous headbutt in 2006 final
Won the Champions League as both player and manager
Master of elegance and technique
French midfield maestro
6. Kylian Mbappe
Scored a hat-trick in a World Cup final
Known for lightning speed
Won the World Cup at age 19
Plays for Real Madrid (formerly PSG)
French national team captain
7. Erling Haaland
Broke the Premier League single-season scoring record
Known as "The Terminator"
Plays for Manchester City
Incredible physical strength and finishing
Norwegian goal machine
8. Ronaldinho
Always played with a smile
Won the 2005 Ballon d'Or
Master of tricks and "Joga Bonito"
Barcelona and Brazil icon
Known for the elastico and overhead kicks
9. Neymar Jr
Brazil's all-time leading scorer
World's most expensive transfer to PSG
Part of the famous MSN trio at Barca
Incredible flair and skill
Won the Olympic gold for Brazil
10. Robert Lewandowski
Scored 5 goals in 9 minutes
Legendary striker for Bayern Munich and Barca
Polish national team captain
Known for clinical finishing
Won the FIFA Best Player twice
11. Luka Modric
Led Croatia to the 2018 World Cup final
Won the 2018 Ballon d'Or
Real Madrid midfield engine
Known for outside-of-the-boot passes
Incredible longevity at the top level
12. Karim Benzema
2022 Ballon d'Or winner
Second all-time scorer for Real Madrid
Won 5 Champions League titles
Known for link-up play and finishing
Former French national team striker
13. Kevin De Bruyne
Master of assists in the Premier League
Manchester City's creative heartbeat
Known for pinpoint crossing and vision
Belgian midfield superstar
Considered one of the best passers ever
14. Mohamed Salah
Liverpool's all-time Premier League scorer
Known as the "Egyptian King"
Multiple Golden Boot winner
Famous for his speed and left foot
National hero in Egypt
15. Harry Kane
England's all-time leading scorer
Joined Bayern Munich from Tottenham
One of the best all-round strikers
Known for passing range and finishing
England national team captain
16. Virgil van Dijk
Considered one of the best defenders ever
Transformed Liverpool's defense
Known for his composure and aerial strength
Dutch national team captain
UEFA Men's Player of the Year 2019
17. Manuel Neuer
Revolutionized the "Sweeper Keeper" role
Won the 2014 World Cup with Germany
Bayern Munich legend
Known for incredible reflexes and distribution
One of the greatest goalkeepers ever
18. Sergio Ramos
Legendary defender for Real Madrid and Spain
Known for scoring clutch headers
Won 4 Champions League titles
Aggressive and leadership-focused style
Most capped player for Spain
19. Andres Iniesta
Scored the winning goal in the 2010 World Cup final
Barcelona's midfield magician
Known for his "La Croqueta" move
Unbelievable control in tight spaces
Won every major trophy possible
20. Xavi Hernandez
The architect of Tiki-Taka
Barcelona's midfield brain
Known for 360-degree vision
Incredible pass accuracy
Managed Barcelona after retiring
21. Thierry Henry
Arsenal's all-time leading scorer
Part of the "Invincibles" team
Known for his pace and clinical finishing
French legend who won the 1998 World Cup
Famous for his va-va-voom style
22. Luis Suarez
Won the Golden Shoe twice in Messi/Ronaldo era
Part of the MSN trio
Known for his tenacity and finishing
Uruguay's all-time leading scorer
Incredible goal against Norwich (many of them)
23. Gianluigi Buffon
Played in 5 World Cups
Juventus and Italy legend
Won the 2006 World Cup
Known for his longevity and leadership
One of the greatest shot-stoppers
24. Kaka
Last player to win Ballon d'Or before Messi/Ronaldo era
AC Milan legend
Incredible pace with the ball
Won the 2002 World Cup with Brazil
Graceful attacking midfielder
25. Steven Gerrard
Liverpool's legendary captain
Inspired the "Miracle of Istanbul"
Known for powerful long-range goals
One of the best box-to-box midfielders
Played his entire career for one club (mostly)
26. Frank Lampard
Chelsea's all-time leading scorer as a midfielder
Known for his late runs into the box
Incredible goal-scoring record
Won the Champions League in 2012
High footballing IQ
27. Wayne Rooney
Man Utd's all-time leading scorer
Known for his overhead kick vs Man City
Burst onto the scene at Euro 2004
Won every major club trophy
Tenacious and versatile forward
28. David Beckham
Famous for his free-kicks and crossing
Global icon who played for Man Utd, Real Madrid, LA Galaxy
Known for the "Bend it like Beckham" technique
Captain of England for many years
Part of the Class of '92
29. Iker Casillas
Captained Spain to 2 Euro titles and 1 World Cup
Real Madrid's "Saint Iker"
Known for incredible saves
One of the most successful goalkeepers
Won 3 Champions League titles
30. Paolo Maldini
Spent 25 seasons at AC Milan
One of the greatest defenders of all time
Known for his reading of the game
Won 5 Champions League titles
Rarely ever had to make a tackle
31. Johan Cruyff
The father of "Total Football"
Ajax and Barcelona legend
Invented the "Cruyff Turn"
Won 3 Ballon d'Ors
Revolutionized the game as a manager
32. Franz Beckenbauer
Nicknamed "Der Kaiser"
Won the World Cup as both player and manager
Invented the modern Libero role
Bayern Munich and Germany legend
Incredible elegance on the ball
33. George Best
Known as the "Fifth Beatle"
Manchester United legend
Incredible dribbling ability
Won the Ballon d'Or in 1968
"Maradona good, Pele better, George Best"
34. Eusebio
The "Black Panther" of Portuguese football
Benfica legend
Top scorer of the 1966 World Cup
Incredible power and speed
First great African-born superstar
35. Gerd Muller
Nicknamed "Der Bomber"
Incredible goal-per-game ratio
Scored the winner in the 1974 World Cup final
Bayern Munich's greatest ever scorer
Master of the penalty area
36. Marco van Basten
Scored an incredible volley in Euro 1988 final
Won 3 Ballon d'Ors
Career cut short by injury at age 28
AC Milan and Ajax legend
The complete striker
37. Michel Platini
Won 3 consecutive Ballon d'Ors
Led France to Euro 1984 victory
Midfield playmaker with incredible scoring record
Juventus legend
Former UEFA president
38. Rivaldo
Won the 2002 World Cup with Brazil
Famous for his overhead kick vs Valencia
Incredible left foot
Won the 1999 Ballon d'Or
Barcelona legend
39. Cafu
Only player to play in 3 World Cup finals
Most capped player for Brazil
Legendary attacking right-back
Won 2 World Cups
Known for his incredible stamina
40. Roberto Carlos
Famous for his "impossible" free-kick vs France
Incredible power in his left foot
Real Madrid and Brazil legend
Revolutionized the attacking left-back role
Known for his massive thighs
41. Zlatan Ibrahimovic
Scored over 500 career goals
Known for his acrobatic strikes
Played for Ajax, Juve, Inter, Barca, Milan, PSG, Utd
"Zlatan doesn't do auditions"
Iconic personality and confidence
42. Toni Kroos
The "Sniper" of midfield
Won 6 Champions League titles
Known for his incredible passing accuracy
German legend who won the 2014 World Cup
Retired at the top of his game in 2024
43. Antoine Griezmann
Key player in France's 2018 World Cup win
Atletico Madrid's all-time scorer
Versatile forward with high work rate
Known for his creativity and finishing
Nicknamed "Grizi"
44. Son Heung-min
First Asian player to win the PL Golden Boot
Tottenham Hotspur captain
Known for his incredible finishing with both feet
Global icon for South Korean football
Famous "camera" celebration
45. Jude Bellingham
Real Madrid's new superstar
Burst onto the scene at Birmingham City
Incredible maturity for his age
Known for his box-to-box play and goals
Future England captain contender
46. Vinicius Jr
Scored the winning goal in 2022 CL final
Known for his incredible speed and dribbling
Real Madrid's main attacking threat
Brazilian flair and confidence
Face of the fight against racism in football
47. Rodri
Manchester City's midfield anchor
Scored the winner in the 2023 CL final
Known for his tactical intelligence and passing
Unbeatable when he starts for City
Spanish national team core
48. Bukayo Saka
Arsenal's "Starboy"
Key player for England
Known for his dribbling and crossing
Incredible character and resilience
Left-footed winger
49. Phil Foden
The "Stockport Iniesta"
Manchester City academy graduate
Known for his close control and vision
PL Player of the Season 2023/24
Incredible technical ability
50. Alisson Becker
Liverpool's reliable goalkeeper
Known for his incredible one-on-one saves
Scored a last-minute header to save Liverpool's season
Brazilian national team number one
Calm and composed under pressure
`;

const PLAYERS_BASKETBALL_TEXT = `
1. Michael Jordan
6-time NBA champion
Never lost an NBA Final
The "GOAT" for many
Famous for his Air Jordan brand
Played for the Chicago Bulls
2. LeBron James
NBA's all-time leading scorer
Won championships with 3 different teams
Known as "The King"
Incredible longevity and versatility
Played for Cavs, Heat, Lakers
3. Kobe Bryant
The "Black Mamba"
Won 5 championships with the Lakers
Scored 81 points in a single game
Known for his "Mamba Mentality"
Legendary work ethic and scoring
4. Stephen Curry
Revolutionized the game with the 3-pointer
All-time leader in 3-pointers made
2-time NBA MVP
Won 4 championships with the Warriors
Best shooter in history
5. Shaquille O'Neal
Most dominant physical force in history
Nicknamed "Shaq"
Won 3-peat with the Lakers
Famous for breaking backboards
Larger-than-life personality
6. Magic Johnson
Best point guard in history
Led the "Showtime" Lakers
Won 5 NBA championships
Incredible passing and vision
Famous rivalry with Larry Bird
7. Larry Bird
"Larry Legend"
3-time NBA champion with the Celtics
Incredible shooter and trash talker
Won 3 consecutive MVPs
Boston Celtics icon
8. Kareem Abdul-Jabbar
Held the scoring record for 39 years
Invented the "Skyhook"
Won 6 NBA championships
6-time NBA MVP
Lakers and Bucks legend
9. Kevin Durant
"The Slim Reaper"
One of the greatest scorers ever
2-time NBA champion
Known for his unguardable jump shot
Played for Thunder, Warriors, Nets, Suns
10. Giannis Antetokounmpo
The "Greek Freak"
2-time NBA MVP
Led the Bucks to the 2021 championship
Incredible athleticism and drive
From selling watches in Greece to NBA superstardom
11. Nikola Jokic
The "Joker"
3-time NBA MVP
Led the Nuggets to their first title in 2023
Best passing center in history
Known for his unique, slow-paced style
12. Luka Doncic
Slovenian superstar
Known for his incredible scoring and passing
Plays for the Dallas Mavericks
Made the All-NBA First Team multiple times
"Luka Magic"
13. Bill Russell
Won 11 NBA championships
The greatest winner in sports history
Boston Celtics legend
Incredible defensive player
NBA Finals MVP trophy is named after him
14. Wilt Chamberlain
Once scored 100 points in a game
Averaged 50 points per game in a season
Only player to grab 55 rebounds in a game
"The Big Dipper"
Incredible physical records
15. Tim Duncan
"The Big Fundamental"
5-time NBA champion with the Spurs
Best power forward ever
Known for his bank shot and quiet leadership
Played his entire 19-year career with the Spurs
16. Allen Iverson
"The Answer"
Pound-for-pound one of the greatest
Famous for his "crossover"
Iconic style and influence on culture
Played for the 76ers
17. Dwyane Wade
"Flash"
3-time NBA champion with the Heat
Incredible shot-blocking guard
Legendary 2006 Finals performance
Miami Heat icon
18. Dirk Nowitzki
Greatest European player ever
Led the Mavs to 2011 championship
Famous for his one-legged fadeaway
Played 21 seasons for the Mavericks
One of the best shooting big men
19. Hakeem Olajuwon
"The Dream"
Invented the "Dream Shake"
2-time NBA champion with the Rockets
Best defensive player and post-scorer
Born in Nigeria
20. Julius Erving
"Dr. J"
Revolutionized the dunk
Incredible style and grace
ABA and NBA legend
Played for the 76ers
21. Jerry West
"The Logo" (literally the NBA logo)
Lakers legend
Known for his clutch shooting
Only player to win Finals MVP on losing team
Incredible executive after retiring
22. Oscar Robertson
"The Big O"
First player to average a triple-double
NBA champion with the Bucks
Incredible all-around player
Cincinnati Royals legend
23. James Harden
"The Beard"
Incredible scoring and isolation play
Former NBA MVP
Known for his step-back 3-pointer
Led the league in scoring 3 times
24. Russell Westbrook
Averaged a triple-double for 4 seasons
All-time leader in triple-doubles
"Mr. Triple Double"
Incredible intensity and athleticism
Former NBA MVP
25. Kawhi Leonard
"The Klaw"
2-time Finals MVP with different teams
Led Raptors to their first title in 2019
Best two-way player in the league
Quiet and stoic personality
26. Chris Paul
"CP3" or "Point God"
One of the best traditional point guards
Incredible leadership and IQ
High assist and steal numbers
Led many teams to their best seasons
27. Anthony Davis
"AD" or "The Brow"
NBA champion with the Lakers
Incredible defensive presence and scoring
Known for his versatility as a big man
Former No. 1 overall pick
28. Joel Embiid
"The Process"
2023 NBA MVP
Dominant scoring center for the 76ers
Known for his social media presence
Born in Cameroon
29. Jayson Tatum
The face of the Boston Celtics
Led the Celtics to the 2024 championship
Incredible scoring ability
Young superstar mentored by Kobe
Smooth offensive game
30. Kyrie Irving
Best ball-handler in NBA history
Scored the winning shot in 2016 Finals
Incredible finishing at the rim
Known for his flashy and creative play
Won a title with LeBron
31. Damian Lillard
"Dame Time"
Known for his deep 3-pointers and clutch shots
Plays for the Bucks (formerly Blazers)
One of the best scoring guards
Famous "wave goodbye" after series winner
32. Paul George
"PG-13"
One of the best two-way wings
Known for his smooth offensive game
Overcame a horrific leg injury
Plays for the 76ers (formerly Clippers, Pacers)
33. Jimmy Butler
"Jimmy Buckets"
Led the Heat to two NBA Finals
Incredible playoff performer
Known for his tough and gritty style
Started his own coffee brand "Big Face Coffee"
34. Ja Morant
Incredible high-flying dunks
Plays for the Memphis Grizzlies
Known for his speed and athleticism
NBA Rookie of the Year 2020
Exciting and explosive playstyle
35. Victor Wembanyama
"Wemby"
Tallest player in the league with guard skills
Incredible hype before entering the NBA
Plays for the San Antonio Spurs
The future face of the NBA
36. Zion Williamson
Most hyped prospect since LeBron
Incredible power and leaping ability
Plays for the New Orleans Pelicans
Dominant force in the paint
Known for his explosive dunks
37. Klay Thompson
One half of the "Splash Brothers"
Scored 37 points in a single quarter
Won 4 championships with the Warriors
Incredible 3-and-D player
Holds the record for most 3s in a game (14)
38. Draymond Green
The heart and soul of the Warriors dynasty
Known for his defense and playmaking
4-time NBA champion
Incredible basketball IQ and intensity
Defensive Player of the Year 2017
39. Ray Allen
One of the greatest shooters ever
Hit the famous corner 3 in 2013 Finals
Won titles with Celtics and Heat
Held the 3-point record before Curry
Known for his perfect shooting form
40. Reggie Miller
"Miller Time"
Indiana Pacers legend
Incredible clutch shooter and trash talker
Famous for scoring 8 points in 9 seconds
One of the best shooters in history
41. Carmelo Anthony
One of the best pure scorers ever
New York Knicks and Denver Nuggets icon
Famous for his mid-range game
Won 3 Olympic Gold medals
Top 10 all-time in scoring
42. Tracy McGrady
"T-Mac"
Scored 13 points in 33 seconds
Incredible scoring ability and athleticism
Won two scoring titles
One of the best "what if" careers due to injury
43. Vince Carter
"Half Man, Half Amazing" or "Vinsanity"
Greatest dunker in history
Played a record 22 seasons
Famous for the 2000 Slam Dunk Contest
Raptors and Nets legend
44. Scottie Pippen
The ultimate wingman to Michael Jordan
6-time NBA champion
One of the best perimeter defenders ever
Incredible versatility and IQ
Chicago Bulls legend
45. Isiah Thomas
Leader of the "Bad Boy" Pistons
2-time NBA champion
Incredible small guard with tough mentality
Beat Jordan, Bird, and Magic in their primes
Detroit Pistons icon
46. John Stockton
All-time leader in assists and steals
Played his entire career for the Utah Jazz
Famous for his pick-and-roll with Karl Malone
Never missed the playoffs in 19 seasons
The ultimate traditional point guard
47. Karl Malone
"The Mailman"
Second all-time in scoring for a long time
2-time NBA MVP
Utah Jazz legend
Incredible physical strength and longevity
48. Charles Barkley
"Sir Charles" or "The Round Mound of Rebound"
1993 NBA MVP
One of the best players never to win a title
Larger-than-life personality and commentator
Incredible rebounder for his size
49. David Robinson
"The Admiral"
2-time NBA champion with the Spurs
1995 NBA MVP
Served in the US Navy before the NBA
Once scored 71 points in a game
50. Manu Ginobili
Revolutionized the "Euro Step"
4-time NBA champion with the Spurs
Best sixth man in history
Led Argentina to Olympic Gold in 2004
Incredible creativity and fearlessness
`;

let PLAYERS = [];
const parsePlayers = (txt, type) => {
    const lines = txt.split(/\r?\n/);
    const entries = [];
    let current = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const m = line.match(/^(\d+)\.\s+(.*)$/);
        if (m) {
            const name = m[2].trim();
            if (current) entries.push(current);
            current = { name, hints: [], type };
            continue;
        }
        if (current) current.hints.push(line);
    }
    if (current) entries.push(current);
    return entries.map(e => ({ name: e.name, hints: e.hints.slice(0, 5), type: e.type }));
};

const loadPlayers = () => {
    PLAYERS = [
        ...parsePlayers(PLAYERS_CHESS_TEXT, 'chess'),
        ...parsePlayers(PLAYERS_FOOTBALL_TEXT, 'football'),
        ...parsePlayers(PLAYERS_BASKETBALL_TEXT, 'basketball')
    ];
};
loadPlayers();

// ---------------------------
// Register commands
// ---------------------------
client.once(Events.ClientReady, async () => {
    try {
        await client.application.commands.set([
            { name: 'daily', description: 'Claim your daily stipend (25 coins)' },
            { name: 'balance', description: 'Check your or another player\'s treasury balance', options: [{ name: 'user', description: 'User to check', type: ApplicationCommandOptionType.User, required: false }] },
            { name: 'leaderboard', description: 'View the top legends (Global or Server)', options: [{ name: 'scope', description: 'Leaderboard scope', type: ApplicationCommandOptionType.String, required: false, choices: [{ name: 'Global', value: 'global' }, { name: 'Server', value: 'server' }] }] },
            { name: 'shop', description: 'Browse the server\'s most expensive stuff' },
            { 
                name: 'item', 
                description: 'Manage the server shop (Admins only)',
                default_member_permissions: ADMIN_PERMS.toString(),
                options: [
                    {
                        name: 'create',
                        description: 'Forge a new shop item',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'name', description: 'Name of the item', type: ApplicationCommandOptionType.String, required: true },
                            { name: 'role', description: 'Role to award', type: ApplicationCommandOptionType.Role, required: true },
                            { name: 'price', description: 'Cost in coins', type: ApplicationCommandOptionType.Integer, required: true }
                        ]
                    },
                    {
                        name: 'edit',
                        description: 'Modify an existing shop item',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'name', description: 'Item to edit', type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
                            { name: 'new_name', description: 'New name', type: ApplicationCommandOptionType.String, required: false },
                            { name: 'price', description: 'New price', type: ApplicationCommandOptionType.Integer, required: false },
                            { name: 'role', description: 'New role', type: ApplicationCommandOptionType.Role, required: false }
                        ]
                    },
                    {
                        name: 'delete',
                        description: 'Remove an item from the shop',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'name', description: 'Item to delete (type "all" for full wipe)', type: ApplicationCommandOptionType.String, required: true, autocomplete: true }
                        ]
                    }
                ]
            },
            {
                name: 'shop-delete-all',
                description: 'Nuke the entire server shop (Admins only)',
                default_member_permissions: ADMIN_PERMS.toString()
            },
            {
                name: 'admin-backup',
                description: 'Generate recovery protocols (Owner only)'
            },
            { 
                name: 'quiz', 
                description: 'Test your brain for rewards (30s cooldown)',
                options: [
                    {
                        name: 'type',
                        description: 'Category: Nerd Board Game, Football, or Basketball',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: 'Nerd Board Game', value: 'chess' },
                            { name: 'Football', value: 'football' },
                            { name: 'Basketball', value: 'basketball' }
                        ]
                    }
                ]
            },
            { 
                name: 'guesstheplayer', 
                description: 'Identify the mystery pro (1m cooldown)',
                options: [
                    {
                        name: 'type',
                        description: 'Category: Nerd Board Game, Football, or Basketball',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: 'Football', value: 'football' },
                            { name: 'Nerd Board Game', value: 'chess' },
                            { name: 'Basketball', value: 'basketball' }
                        ]
                    }
                ]
            },
            { name: 'guess', description: 'Submit your intel on the mystery person', options: [{ name: 'name', description: 'Name of the person', type: ApplicationCommandOptionType.String, required: true }] },
            { name: 'ration', description: 'View your tactical performance stats' },
            { name: 'questions', description: 'Review the nerd lord question bank (Admins only)', default_member_permissions: ADMIN_PERMS.toString(), options: [{ name: 'page', description: 'Bank page', type: ApplicationCommandOptionType.Integer, required: false }] },
            { name: 'addmoney', description: 'Deposit coins into a treasury (Admins only)', default_member_permissions: ADMIN_PERMS.toString(), options: [{ name: 'user', description: 'Recipient', type: ApplicationCommandOptionType.User, required: true }, { name: 'amount', description: 'Amount to deposit', type: ApplicationCommandOptionType.Integer, required: true }] },
            { name: 'removemoney', description: 'Confiscate coins from a treasury (Admins only)', default_member_permissions: ADMIN_PERMS.toString(), options: [{ name: 'user', description: 'Target', type: ApplicationCommandOptionType.User, required: true }, { name: 'amount', description: 'Amount to seize', type: ApplicationCommandOptionType.Integer, required: true }] },
            { name: 'help', description: 'The ultimate guide to dominating the server' }
        ]);
        console.log(`✅ Logged in as ${client.user.tag}`);
    } catch (error) {
        console.error("Command Registration Error:", error);
    }
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (message.mentions.has(client.user) && !message.mentions.everyone) {
        const embed = new EmbedBuilder()
            .setTitle("🤖 Bot Commands")
            .setDescription("Yo! Here is how you can use the @Quiz Bot to get rich and flex on others:")
            .addFields(
                { 
                    name: '💎 Economy & Daily', 
                    value: '`/daily` - Claim your daily 25 coins\n`/balance [user]` - Check your or someone else\'s coin balance\n`/leaderboard [scope]` - View top players (Global or Server)' 
                },
                { 
                    name: '🎮 Games & Quizzes', 
                    value: '`/quiz <type>` - Start a multiple-choice quiz (30s cooldown)\n`/guesstheplayer <type>` - Start "Guess the Pro" (1m cooldown)\n`/guess <name>` - Submit your person guess\n`/ration` - View your accuracy and statistics' 
                },
                { 
                    name: '🛒 Server Shop', 
                    value: '`/shop` - View items available in this server\'s shop\n`/item buy <name>` - Purchase a role from the shop' 
                },
                { 
                    name: '🛠️ Admin Commands', 
                    value: '`/item create <name> <role> <price>` - Add a new item to the shop\n`/item edit <name> [new_name] [price] [role]` - Edit a shop item\n`/item delete <name>` - Remove an item from the shop\n`/shop-delete-all` - Clear the entire server shop\n`/addmoney <user> <amount>` - Add coins to a user\n`/removemoney <user> <amount>` - Remove coins from a user\n`/questions [page]` - View the nerd lord question bank' 
                }
            )
            .setColor(0x3498DB)
            .setFooter({ text: "Tip: Use /help for the full guide to greatness!" })
            .setTimestamp();
        
        await message.reply({ embeds: [embed] }).catch(() => {});
    }
});

// ---------------------------
// Quiz logic
// ---------------------------
async function getRandomQuizForUser(userId, type) {
    const history = await getQuizHistory(userId);
    const filteredPool = QUIZ_POOL.filter(q => q.type === type);
    const remaining = filteredPool.filter(q => !history.includes(q.id));
    
    if (remaining.length === 0) {
        // If all questions of this type were asked, clear history for this type only? 
        // Actually, the current logic clears ALL history. Let's stick to that but only for the specific type pool.
        // Or better, just pick a random one from the filtered pool.
        return filteredPool[Math.floor(Math.random() * filteredPool.length)];
    }
    return remaining[Math.floor(Math.random() * remaining.length)];
}

// ---------------------------
// Interaction Handler
// ---------------------------
client.on(Events.InteractionCreate, async interaction => {
    // 1. Immediate Deferral to prevent "Application didn't respond"
    try {
        if (interaction.isAutocomplete()) {
            const focusedValue = interaction.options.getFocused();
            const shopItems = await dbAll('SELECT itemName FROM server_shop WHERE guildId = ?', [interaction.guild.id]);
            const filtered = shopItems
                .filter(item => item.itemName.toLowerCase().includes(focusedValue.toLowerCase()))
                .map(item => ({ name: item.itemName, value: item.itemName }));
            
            // Limit to 25 choices (Discord limit)
            await interaction.respond(filtered.slice(0, 25)).catch(() => {});
            return;
        }

        if (interaction.isButton()) {
            await interaction.deferUpdate().catch(() => {});
        } else if (interaction.isChatInputCommand()) {
            await interaction.deferReply().catch(() => {});
        } else {
            return;
        }
    } catch (e) {
        console.error("Deferral Error:", e);
        return;
    }

    const { user, guild } = interaction;

    // 2. Background Tasks (Non-blocking)
    if (guild) {
        upsertGuildUser(guild.id, user.id).catch(() => {});
    }

    try {
        if (interaction.isButton()) {
            const { customId } = interaction;
            if (customId === 'shop_close') {
                await interaction.editReply({ components: [] });
                return;
            }
            if (customId.startsWith('quiz_choice:')) {
                const choice = customId.split(':')[1];
                const active = await getActiveQuestion(user.id);
                if (!active) {
                    await interaction.followUp({ content: "❌ This quiz has expired or you don't have an active one.", ephemeral: true });
                    return;
                }

                const q = QUIZ_POOL.find(i => i.id === active.quizId);
                const timeLimitMs = 60 * 1000;
                const timedOut = (Date.now() - active.askedAt) > timeLimitMs;
                const correct = choice === q.answer;

                await clearActiveQuestion(user.id);
                await setCooldown(user.id);
                await addQuizToHistory(user.id, q.id);

                if (timedOut) {
                    await incQuizStat(user.id, 'wrong');
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "⏱️ Brain Lag" })
                        .setTitle("Time is up!")
                        .setDescription(`You were too slow. The correct answer was: **${q.answer}**`)
                        .setColor(0xE67E22);
                    await interaction.editReply({ embeds: [embed], components: [] });
                    return;
                }

                if (correct) {
                    await incQuizStat(user.id, 'correct');
                    await addUserCoins(user.id, q.reward, guild.id);
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "✅ Big Brain Energy" })
                        .setTitle("Galaxy Brain!")
                        .setDescription(`**${choice}** is correct!`)
                        .addFields({ name: '💰 Reward Earned', value: `\`${q.reward}\` coins`, inline: true })
                        .setColor(0x2ECC71);
                    await interaction.editReply({ embeds: [embed], components: [] });
                } else {
                    await incQuizStat(user.id, 'wrong');
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "❌ Mega Oopsie" })
                        .setTitle("Terrible Attempt")
                        .setDescription(`That wasn't quite right. The correct answer was: **${q.answer}**`)
                        .setColor(0xE74C3C);
                    await interaction.editReply({ embeds: [embed], components: [] });
                }
                return;
            }

            if (customId === 'guess_next') {
                const active = await getGuessActive(user.id);
                if (!active) { await interaction.followUp({ content: "No active Guess the Player.", ephemeral: true }); return; }
                const entry = PLAYERS.find(p => p.name === active.playerName);
                if (!entry) { await interaction.followUp({ content: "This guess is no longer valid.", ephemeral: true }); return; }
                
                // Hint cost: 5 coins for hints after the first one
                const HINT_COST = 5;
                const data = await getServerUserData(guild.id, user.id);
                if (data.coins < HINT_COST) {
                    await interaction.followUp({ content: `❌ You need **${HINT_COST} coins** to reveal another hint!`, ephemeral: true });
                    return;
                }

                await addUserCoins(user.id, -HINT_COST, guild.id);
                const newData = await getServerUserData(guild.id, user.id);

                let idx = active.hintIndex + 1;
                if (idx > entry.hints.length) idx = entry.hints.length;
                await setGuessHintIndex(user.id, idx);
                
                const shown = entry.hints.slice(0, idx).map((h, i) => `Hint ${i+1}: ${h}`).join('\n');
                const embed = new EmbedBuilder()
                    .setTitle("🕵️ Guess the Player")
                    .setDescription(shown)
                    .setColor(0x8E44AD)
                    .setFooter({ text: `Balance: ${newData.coins} coins • Next hint: 5 coins` });

                const label = idx >= entry.hints.length ? 'No more hints' : `Next Hint (5 Coins)`;
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('guess_next')
                        .setLabel(label)
                        .setStyle(idx >= entry.hints.length ? ButtonStyle.Secondary : ButtonStyle.Primary)
                        .setDisabled(idx >= entry.hints.length)
                );
                await interaction.editReply({ embeds: [embed], components: [row] });
                return;
            }
            if (customId.startsWith('shop_buy:')) {
                const itemName = customId.split(':')[1];
                const item = (await dbAll('SELECT * FROM server_shop WHERE guildId = ? AND itemName = ?', [guild.id, itemName]))[0];
                if (!item) { await interaction.followUp({ content: "Item no longer exists in the shop.", ephemeral: true }); return; }
                
                const member = await guild.members.fetch(user.id);
                const role = guild.roles.cache.get(item.roleId);
                if (!role) { await interaction.followUp({ content: `The role associated with this item no longer exists.`, ephemeral: true }); return; }
                if (member.roles.cache.has(role.id)) { await interaction.followUp({ content: "You already own this role.", ephemeral: true }); return; }
                
                const data = await getServerUserData(guild.id, user.id);
                if (data.coins < item.price) { await interaction.followUp({ content: "Insufficient funds in this server to buy this item.", ephemeral: true }); return; }
                
                await member.roles.add(role.id);
                await addUserCoins(user.id, -item.price, guild.id);
                
                const newMember = await guild.members.fetch(user.id);
                const newData = await getServerUserData(guild.id, user.id);
                const shopItems = await dbAll('SELECT * FROM server_shop WHERE guildId = ? ORDER BY price ASC', [guild.id]);
                
                const fields = shopItems.map(s => {
                    const sRole = guild.roles.cache.get(s.roleId);
                    const owned = sRole ? newMember.roles.cache.has(sRole.id) : false;
                    const roleMention = sRole ? `<@&${sRole.id}>` : `Unknown Role`;
                    const ownedTxt = owned ? "Already Owned" : "Not Owned";
                    return { name: `♟️ ${s.itemName}`, value: `💰 Price: ${s.price} coins\n🎭 Role: ${roleMention}\n✅ Status: ${ownedTxt}`, inline: false };
                });
                
                const embed = new EmbedBuilder().setTitle(`🛒 Server Shop • Balance: ${newData.coins} coins`).addFields(fields).setColor(0x3498DB);
                const buttons = shopItems.map(s => {
                    const sRole = guild.roles.cache.get(s.roleId);
                    const owned = sRole ? newMember.roles.cache.has(sRole.id) : false;
                    const label = owned ? `Owned: ${s.itemName}` : `Buy ${s.itemName} • ${s.price} Coins`;
                    return new ButtonBuilder().setCustomId(`shop_buy:${s.itemName}`).setLabel(label).setEmoji('🛒').setStyle(owned ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(owned);
                });
                
                const rows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
                }
                rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop_close').setLabel('Close Shop').setEmoji('🧹').setStyle(ButtonStyle.Danger)));
                
                await interaction.editReply({ embeds: [embed], components: rows });
                
                const successEmbed = new EmbedBuilder()
                    .setAuthor({ name: "🎉 You Got It!" })
                    .setTitle("New Loot!")
                    .setDescription(`You just flexed on everyone by getting the **${item.itemName}** role!`)
                    .addFields(
                        { name: '💰 Price Paid', value: `\`${item.price}\` coins`, inline: true },
                        { name: '🎭 New Rank', value: `<@&${role.id}>`, inline: true }
                    )
                    .setColor(0x2ECC71)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/3144/3144456.png')
                    .setTimestamp();

                await interaction.followUp({ embeds: [successEmbed], ephemeral: true });
                return;
            }
            return;
        }

        if (interaction.isChatInputCommand()) {
            const { commandName, options } = interaction;

            if (commandName === 'help') {
                const embed = new EmbedBuilder()
                    .setTitle("Yo! So this is how to use the @Quiz Bot")
                    .setDescription("Master the board games and test your sports knowledge! Earn coins, climb the leaderboards, and unlock exclusive server roles.")
                    .addFields(
                        { 
                            name: '1️⃣ What is it?', 
                            value: "It's like a mix of a Quiz knowledge and an economy system where you can earn coins and buy roles." 
                        },
                        { 
                            name: '2️⃣ How to use it / Get rich?', 
                            value: "• `/daily`: Use this every day to get free coins. It's literally free money, don't forget it.\n• `/quiz <type>`: Get one of 150+ unique questions to answer in 60s. Solve correctly and get coins. Choose between **Nerd Board Game**, **Football**, or **Basketball**! (30s cooldown)\n• `/guesstheplayer <type>`: The bot gives you hints about a famous person. First hint is free, others cost 5 coins. (1m cooldown)\n• `/guess <name>`: Use this to submit your answer for the \"Guess the Pro\" game.\n• `/ration`: See how many quiz questions you've actually gotten right." 
                        },
                        { 
                            name: '🛒 Spending Your Cash', 
                            value: "But after having Money what are you gonna do with it?\n• `/shop`: Check out what you can buy. Usually, it's cool roles like \"Legendary NPC\" or \"Ultimate Lifeform.\"\n• `/balance [user]`: Check how many coins you or another user actually have so you know if you're broke or not." 
                        },
                        { 
                            name: '🏆 Competitive Aspects', 
                            value: "• `/leaderboard scope`: See who the richest players in the Global or Server boards are. Try to get to the top!" 
                        },
                        { 
                            name: '🛠️ Admin Stuff (If you have permissions)', 
                            value: "• `/addmoney <user> <amount>`: Give someone coins (or yourself, lol).\n• `/removemoney <user> <amount>`: Take coins away if someone is being annoying.\n• `/questions [page]`: See all the questions in the nerd lord question bank.\n• `/item create <name> <role> <price>`: Create an item for the shop (up to 10).\n• `/item edit <name>`: Edit a created item.\n• `/item delete <name>`: Delete a created item from the shop.\n• `/shop-delete-all`: Simply delete the entire shop." 
                        }
                    )
                    .setColor(0x3498DB)
                    .setFooter({ text: "Basically, just spam /daily and /quiz to get coins, then flex on everyone with a cool role!" })
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'shop-delete-all') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) && !interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                    return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can clear the shop.", ephemeral: true });
                }
                await new Promise((res, rej) => {
                    db.run('DELETE FROM server_shop WHERE guildId = ?', [guild.id], e => e ? rej(e) : res());
                });
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "🧹 Shop Maintenance" })
                    .setTitle("Boutique Cleared")
                    .setDescription("All items have been successfully removed from the server shop.")
                    .setColor(0xE67E22)
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'quiz') {
                const type = options.getString('type');
                const active = await getActiveQuestion(user.id);
                const timeLimitMs = 60 * 1000;
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
                const cooldownTime = 30 * 1000; // 30 seconds
                if (row && (Date.now() - row.lastUsed < cooldownTime)) {
                    const diff = cooldownTime - (Date.now() - row.lastUsed);
                    const s = Math.ceil(diff / 1000);
                    const embed = new EmbedBuilder()
                        .setTitle("⏳ Cooldown Active")
                        .setDescription(`Try again in **${s}s**.`)
                        .setColor(0x95A5A6);
                    return interaction.editReply({ embeds: [embed] });
                }
                
                // Filter quiz pool by selected type
                const filteredPool = QUIZ_POOL.filter(q => q.type === type);
                if (filteredPool.length === 0) {
                    return interaction.editReply(`❌ No questions available for: **${type}**`);
                }

                const history = await getQuizHistory(user.id);
                const remaining = filteredPool.filter(q => !history.includes(q.id));
                let q;
                if (remaining.length === 0) {
                    await new Promise(res => db.run('DELETE FROM quiz_history WHERE userId = ?', [user.id], res));
                    q = filteredPool[Math.floor(Math.random() * filteredPool.length)];
                } else {
                    q = remaining[Math.floor(Math.random() * remaining.length)];
                }

                // Generate 3 choices (1 correct, 2 wrong from the question's own 'wrong' array)
                const choices = [q.answer, ...q.wrong].sort(() => 0.5 - Math.random());

                await setActiveQuestion(user.id, q.id);
                
                const embed = new EmbedBuilder()
                    .setAuthor({ name: `🧠 ${type.charAt(0).toUpperCase() + type.slice(1)} Challenge`, iconURL: 'https://cdn-icons-png.flaticon.com/512/3565/3565418.png' })
                    .setTitle("Knowledge Test")
                    .setDescription(`**Question:**\n${q.question}\n\n⏱️ **Time Limit:** \`60 seconds\`\n📝 **Choose the correct answer below!**`)
                    .setColor(0x2ECC71)
                    .addFields({ name: '💰 Potential Reward', value: `\`${q.reward}\` coins`, inline: true })
                    .setFooter({ text: `Good luck, ${user.username}!` })
                    .setTimestamp();

                const buttons = new ActionRowBuilder().addComponents(
                    choices.map(choice => 
                        new ButtonBuilder()
                            .setCustomId(`quiz_choice:${choice}`)
                            .setLabel(choice)
                            .setStyle(ButtonStyle.Primary)
                    )
                );

                return interaction.editReply({ embeds: [embed], components: [buttons] });
            }

            if (commandName === 'guesstheplayer') {
                const type = options.getString('type');
                const row = await getGuessCooldown(user.id);
                const cooldownTime = 60 * 1000; // 1 minute
                if (row && (Date.now() - row.lastUsed < cooldownTime)) {
                    const diff = cooldownTime - (Date.now() - row.lastUsed);
                    const s = Math.ceil(diff / 1000);
                    const embed = new EmbedBuilder()
                        .setTitle("⏳ Recharge Required")
                        .setDescription(`Your tactical vision is recharging. Try again in **${s}s**.`)
                        .setColor(0xE74C3C);
                    return interaction.editReply({ embeds: [embed] });
                }

                const active = await getGuessActive(user.id);
                if (active) {
                    const entry = PLAYERS.find(p => p.name === active.playerName);
                    if (entry) {
                        const idx = Math.max(1, active.hintIndex);
                        const shown = entry.hints.slice(0, idx).map((h, i) => `**Hint ${i+1}:** ${h}`).join('\n');
                        const data = await getServerUserData(guild.id, user.id);
                        
                        const embed = new EmbedBuilder()
                            .setAuthor({ name: "🕵️ Intelligence Report" })
                            .setTitle("Identify the Nerd Lord")
                            .setDescription(`You have an active mission!\n\n${shown}`)
                            .setColor(0x8E44AD)
                            .addFields(
                                { name: '💰 Cost', value: 'Next intel: `5 coins`', inline: true },
                                { name: '🪙 Balance', value: `\`${data.coins}\` coins`, inline: true }
                            )
                            .setFooter({ text: "Use /guess to submit your answer" });
                        
                        const label = idx >= entry.hints.length ? 'All Intel Gathered' : `Next Intel (5 Coins)`;
                        const rowComp = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('guess_next')
                                .setLabel(label)
                                .setStyle(idx >= entry.hints.length ? ButtonStyle.Secondary : ButtonStyle.Primary)
                                .setDisabled(idx >= entry.hints.length)
                        );
                        return interaction.editReply({ embeds: [embed], components: [rowComp] });
                    }
                }
                
                const filteredPlayers = PLAYERS.filter(p => p.type === type);
                if (filteredPlayers.length === 0) {
                    return interaction.editReply(`❌ No people available for category: **${type}**`);
                }

                const p = filteredPlayers[Math.floor(Math.random() * filteredPlayers.length)];
                await setGuessActive(user.id, p.name);
                await setGuessCooldown(user.id);

                const data = await getServerUserData(guild.id, user.id);
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "🕵️ Intelligence Report" })
                    .setTitle(`Identify the ${type === 'chess' ? 'Nerd Lord' : type.charAt(0).toUpperCase() + type.slice(1) + ' Pro'}`)
                    .setDescription(`**Intel 1:** ${p.hints[0]}`)
                    .setColor(0x8E44AD)
                    .addFields(
                        { name: '💰 Cost', value: 'Next intel: `5 coins`', inline: true },
                        { name: '🪙 Balance', value: `\`${data.coins}\` coins`, inline: true }
                    )
                    .setFooter({ text: "Use /guess to answer • Intel costs 5 coins" });

                const rowBtn = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('guess_next').setLabel('Next Intel (5 Coins)').setStyle(ButtonStyle.Primary)
                );
                return interaction.editReply({ embeds: [embed], components: [rowBtn] });
            }

            if (commandName === 'daily') {
                const data = await getUserData(user.id);
                if (Date.now() - data.lastDaily < 86400000) {
                    const remaining = 86400000 - (Date.now() - data.lastDaily);
                    const h = Math.floor(remaining / 3600000);
                    const m = Math.floor((remaining % 3600000) / 60000);
                    const embed = new EmbedBuilder()
                        .setTitle("⏳ Hold Your Horses")
                        .setDescription(`You've already claimed your daily reward. Come back in **${h}h ${m}m**.`)
                        .setColor(0x95A5A6);
                    return interaction.editReply({ embeds: [embed] });
                }
                await addUserCoins(user.id, 25, guild.id);
                await dbRun('UPDATE users SET lastDaily = ? WHERE userId = ?', [Date.now(), user.id]);
                const embed = new EmbedBuilder()
                    .setTitle("🎁 Daily Allowance")
                    .setDescription("Your daily stipend has been deposited into your treasury.")
                    .addFields({ name: '💰 Amount', value: '`25` coins', inline: true })
                    .setColor(0x2ECC71)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/1162/1162951.png')
                    .setFooter({ text: "Come back tomorrow for more!" });
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'balance') {
                const target = options.getUser('user') || user;
                const data = await getServerUserData(guild.id, target.id);
                const embed = new EmbedBuilder()
                    .setAuthor({ name: target.tag, iconURL: target.displayAvatarURL({ dynamic: true }) })
                    .setTitle("💰 Treasury Report")
                    .setDescription(`**${target.username}** currently holds:`)
                    .addFields(
                        { name: '🪙 Server Coins', value: `\`${data.coins.toLocaleString()}\``, inline: true }
                    )
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/272/272525.png')
                    .setColor(0xF1C40F)
                    .setFooter({ text: `Requested by ${user.tag}`, iconURL: user.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'leaderboard') {
                const scope = options.getString('scope') || 'server';
                let rows;
                if (scope === 'server' && guild) {
                    rows = await dbAll('SELECT userId, coins FROM server_coins WHERE guildId = ? ORDER BY coins DESC LIMIT 10', [guild.id]);
                } else {
                    rows = await dbAll('SELECT userId, coins FROM users ORDER BY coins DESC LIMIT 10');
                }
                const medals = ['🥇','🥈','🥉'];
                const txt = rows.map((r, i) => {
                    const medal = medals[i] || `**#${i+1}**`;
                    return `${medal} <@${r.userId}> \u2014 \`${r.coins.toLocaleString()}\` coins`;
                }).join('\n') || "*The records are currently empty.*";
                
                const title = scope === 'server' ? "🏆 Server Power Rankings" : "🌍 Global Hall of Fame";
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "📊 Competitive Standings" })
                    .setTitle(title)
                    .setDescription(`The top 10 people currently dominating the boards.\n\n${txt}`)
                    .setThumbnail(scope === 'server' ? guild.iconURL({ dynamic: true }) : 'https://cdn-icons-png.flaticon.com/512/1021/1021204.png')
                    .setColor(0xFFD700)
                    .setFooter({ text: `Scope: ${scope.charAt(0).toUpperCase() + scope.slice(1)} • Updated just now` })
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'guess') {
                const active = await getGuessActive(user.id);
                if (!active) {
                    const embed = new EmbedBuilder()
                        .setTitle("❌ No Active Stalking Mission")
                        .setDescription("You aren't currently tracking any mystery pros. Start a mission with `/guesstheplayer`!")
                        .setColor(0xE74C3C);
                    return interaction.editReply({ embeds: [embed] });
                }
                const nameInput = options.getString('name');
                const correct = isNameMatch(nameInput, active.playerName);
                
                await clearGuessActive(user.id);
                await setGuessCooldown(user.id);

                if (correct) {
                    await addUserCoins(user.id, 10, guild.id);
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "🎯 Target Found" })
                        .setTitle("Target Identified!")
                        .setDescription(`Insane brain power! The person was indeed **${active.playerName}**.`)
                        .addFields({ name: '💰 Reward Bounty', value: '`10` coins', inline: true })
                        .setColor(0x2ECC71)
                        .setThumbnail('https://cdn-icons-png.flaticon.com/512/190/190411.png')
                        .setFooter({ text: "Your brain is massive." });
                    return interaction.editReply({ embeds: [embed], components: [] });
                }
                
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "❌ Mission Failed" })
                    .setTitle("Identity Mismatch")
                    .setDescription(`Your intelligence was incorrect. The player has escaped.`)
                    .addFields({ name: '👤 Actual Identity', value: `||${active.playerName}||`, inline: true })
                    .setColor(0xE74C3C)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/1156/1156641.png')
                    .setFooter({ text: "Wait for the cooldown to start a new mission." });
                return interaction.editReply({ embeds: [embed], components: [] });
            }
            if (commandName === 'questions') {
                const isAdmin = guild && (interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages));
                if (!isAdmin) return interaction.editReply("❌ Admins or users with Manage Roles only.");
                const pageSize = 20;
                const total = QUIZ_POOL.length;
                const totalPages = Math.ceil(total / pageSize);
                let page = options.getInteger('page') || 1;
                if (page < 1) page = 1;
                if (page > totalPages) page = totalPages;
                const start = (page - 1) * pageSize;
                const slice = QUIZ_POOL.slice(start, start + pageSize);
                const lines = slice.map(q => `**#${q.id}:** ${q.question}`);
                const txt2 = lines.join('\n') || "*No questions found.*";

                const embed = new EmbedBuilder()
                    .setAuthor({ name: "📚 Question Repository" })
                    .setTitle(`Page ${page} of ${totalPages}`)
                    .setDescription(txt2)
                    .setColor(0x3498DB)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/3407/3407024.png')
                    .setFooter({ text: `Admin Access Only • Total Questions: ${total}` });
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'ration') {
                const stats = await getQuizStats(user.id);
                const total = stats.correct + stats.wrong;
                const ratio = total > 0 ? ((stats.correct / total) * 100).toFixed(1) : 0;

                const embed = new EmbedBuilder()
                    .setAuthor({ name: "📊 Brain Power Stats" })
                    .setTitle(`${user.username}'s Statistics`)
                    .setDescription(`Detailed analysis of your brain training sessions.`)
                    .addFields(
                        { name: '✅ Smart Answers', value: `\`${stats.correct}\``, inline: true },
                        { name: '❌ Dumb Mistakes', value: `\`${stats.wrong}\``, inline: true },
                        { name: '📈 Success Rate', value: `\`${ratio}%\``, inline: true }
                    )
                    .setColor(ratio >= 50 ? 0x2ECC71 : 0xE74C3C)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/1611/1611174.png')
                    .setFooter({ text: "Keep practicing to improve your accuracy!" });
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'shop') {
                const shopItems = await dbAll('SELECT * FROM server_shop WHERE guildId = ? ORDER BY price ASC', [guild.id]);
                if (shopItems.length === 0) {
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "🛒 The General Store" })
                        .setTitle("Shop is Currently Closed")
                        .setDescription("The local merchants haven't set up shop here yet. Check back later!")
                        .setColor(0xE74C3C)
                        .setThumbnail('https://cdn-icons-png.flaticon.com/512/1041/1041916.png');
                    return interaction.editReply({ embeds: [embed], ephemeral: true });
                }

                const member = await guild.members.fetch(user.id);
                const data = await getServerUserData(guild.id, user.id);
                const fields = shopItems.map(s => {
                    const sRole = guild.roles.cache.get(s.roleId);
                    const owned = sRole ? member.roles.cache.has(sRole.id) : false;
                    const roleMention = sRole ? `<@&${sRole.id}>` : `Unknown Role`;
                    const status = owned ? "✅ **Already Owned**" : "🛒 **Available**";
                    return {
                        name: `📦 ${s.itemName}`,
                        value: `💰 **Price:** \`${s.price}\` coins\n🎭 **Role:** ${roleMention}\n✨ **Status:** ${status}`,
                        inline: false
                    };
                });
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "🛒 The General Store", iconURL: guild.iconURL({ dynamic: true }) })
                    .setTitle("Server Exclusive Items")
                    .setDescription(`Welcome to the marketplace! You currently have \`${data.coins}\` coins to spend.`)
                    .addFields(fields)
                    .setColor(0x3498DB)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/3081/3081559.png')
                    .setFooter({ text: `Browse at your leisure • ${guild.name}` });

                const buttons = shopItems.map(s => {
                    const sRole = guild.roles.cache.get(s.roleId);
                    const owned = sRole ? member.roles.cache.has(sRole.id) : false;
                    const label = owned ? `Owned` : `${s.price} Coins`;
                    return new ButtonBuilder()
                        .setCustomId(`shop_buy:${s.itemName}`)
                        .setLabel(label)
                        .setEmoji(owned ? '✅' : '🛒')
                        .setStyle(owned ? ButtonStyle.Secondary : ButtonStyle.Primary)
                        .setDisabled(owned);
                });
                const rows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
                }
                rows.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('shop_close').setLabel('Leave Shop').setEmoji('🚪').setStyle(ButtonStyle.Danger)
                ));
                return interaction.editReply({ embeds: [embed], components: rows });
            }

            if (commandName === 'item') {
                const sub = options.getSubcommand();
                if (sub === 'create') {
                    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) && !interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                        return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can create shop items.", ephemeral: true });
                    }
                    const name = options.getString('name');
                    const role = options.getRole('role');
                    const price = options.getInteger('price');

                    const countResult = await dbAll('SELECT COUNT(*) as c FROM server_shop WHERE guildId = ?', [guild.id]);
                    const count = countResult[0].c;
                    if (count >= 10) {
                        const embed = new EmbedBuilder()
                            .setTitle("🚫 Inventory Full")
                            .setDescription("Your shop has reached the maximum capacity of **10 items**. Delete an item to make room for more.")
                            .setColor(0xE74C3C);
                        return interaction.editReply({ embeds: [embed], ephemeral: true });
                    }

                    await new Promise((res, rej) => {
                        db.run('INSERT OR REPLACE INTO server_shop (guildId, itemName, roleId, price) VALUES (?, ?, ?, ?)', [guild.id, name, role.id, price], e => e ? rej(e) : res());
                    });

                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "🛠️ Admin Tools" })
                        .setTitle("Item Created Successfully")
                        .setDescription(`A new item has been added to the store.`)
                        .addFields(
                            { name: '📦 Item Name', value: `\`${name}\``, inline: true },
                            { name: '💰 Price', value: `\`${price}\` coins`, inline: true },
                            { name: '🎭 Role', value: `<@&${role.id}>`, inline: true }
                        )
                        .setColor(0x2ECC71)
                        .setTimestamp();
                    return interaction.editReply({ embeds: [embed] });
                }

                if (sub === 'edit') {
                    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) && !interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                        return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can edit shop items.", ephemeral: true });
                    }
                    const name = options.getString('name');
                    const newName = options.getString('new_name');
                    const newPrice = options.getInteger('price');
                    const newRole = options.getRole('role');

                    const item = (await dbAll('SELECT * FROM server_shop WHERE guildId = ? AND itemName = ?', [guild.id, name]))[0];
                    if (!item) {
                        const embed = new EmbedBuilder()
                            .setTitle("❌ Item Not Found")
                            .setDescription(`The item **${name}** does not exist in your shop.`)
                            .setColor(0xE74C3C);
                        return interaction.editReply({ embeds: [embed], ephemeral: true });
                    }

                    if (newName) {
                        await new Promise((res, rej) => {
                            db.run('UPDATE server_shop SET itemName = ? WHERE guildId = ? AND itemName = ?', [newName, guild.id, name], e => e ? rej(e) : res());
                        });
                    }
                    
                    const currentName = newName || name;
                    
                    if (newPrice !== null) {
                        await new Promise((res, rej) => {
                            db.run('UPDATE server_shop SET price = ? WHERE guildId = ? AND itemName = ?', [newPrice, guild.id, currentName], e => e ? rej(e) : res());
                        });
                    }
                    
                    if (newRole) {
                        await new Promise((res, rej) => {
                            db.run('UPDATE server_shop SET roleId = ? WHERE guildId = ? AND itemName = ?', [newRole.id, guild.id, currentName], e => e ? rej(e) : res());
                        });
                    }
                    
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "🛠️ Merchant Tools" })
                        .setTitle("Item Updated")
                        .setDescription(`Modifications to **${name}** have been finalized.`)
                        .setColor(0x3498DB)
                        .setTimestamp();
                    return interaction.editReply({ embeds: [embed] });
                }

                if (sub === 'delete') {
                    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) && !interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                        return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can delete shop items.", ephemeral: true });
                    }
                    const name = options.getString('name');
                    if (name.toLowerCase() === 'all') {
                        await new Promise((res, rej) => {
                            db.run('DELETE FROM server_shop WHERE guildId = ?', [guild.id], e => e ? rej(e) : res());
                        });
                        const embed = new EmbedBuilder()
                            .setAuthor({ name: "🛠️ Merchant Tools" })
                            .setTitle("Shop Cleared")
                            .setDescription("All items have been removed from the boutique.")
                            .setColor(0xE67E22);
                        return interaction.editReply({ embeds: [embed] });
                    } else {
                        const result = await new Promise((res, rej) => {
                            db.run('DELETE FROM server_shop WHERE guildId = ? AND itemName = ?', [guild.id, name], function(e) {
                                if (e) rej(e);
                                else res(this.changes);
                            });
                        });
                        if (result === 0) {
                            const embed = new EmbedBuilder()
                                .setTitle("❌ Item Not Found")
                                .setDescription(`The item **${name}** does not exist in your shop.`)
                                .setColor(0xE74C3C);
                            return interaction.editReply({ embeds: [embed], ephemeral: true });
                        }
                        const embed = new EmbedBuilder()
                            .setAuthor({ name: "🛠️ Merchant Tools" })
                            .setTitle("Item Removed")
                            .setDescription(`The item **${name}** has been removed from the boutique.`)
                            .setColor(0xE67E22);
                        return interaction.editReply({ embeds: [embed] });
                    }
                }
            }

            if (commandName === 'admin-backup') {
                if (user.id !== '1324354578338025533') {
                    return interaction.editReply({ content: "❌ This is a restricted owner command.", ephemeral: true });
                }

                const serverCoins = await dbAll('SELECT * FROM server_coins WHERE guildId = ?', [guild.id]);
                const shopItems = await dbAll('SELECT * FROM server_shop WHERE guildId = ?', [guild.id]);

                let output = "**Database Backup (Copy these if you reset)**\n\n";
                
                output += "__**Coins Recovery Commands:**__\n";
                if (serverCoins.length === 0) {
                    output += "*No user balances found.*\n";
                } else {
                    for (const row of serverCoins) {
                        if (row.coins > 0) {
                            output += `\`/addmoney user:${row.userId} amount:${row.coins}\` (User: <@${row.userId}>)\n`;
                        }
                    }
                }

                output += "\n__**Shop Recovery Commands:**__\n";
                if (shopItems.length === 0) {
                    output += "*No shop items found.*\n";
                } else {
                    for (const item of shopItems) {
                        output += `\`/item create name:${item.itemName} role:${item.roleId} price:${item.price}\` (Role: <@&${item.roleId}>)\n`;
                    }
                }

                if (output.length > 1900) {
                    return interaction.editReply({ content: "⚠️ Backup too large for a single message. Please check the database manually if possible." });
                }

                const embed = new EmbedBuilder()
                    .setAuthor({ name: "🛡️ Owner Security Tool" })
                    .setTitle("Manual Data Backup")
                    .setDescription(output)
                    .setColor(0x9B59B6)
                    .setFooter({ text: "Use these commands to restore data after a reset." })
                    .setTimestamp();
                
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'addmoney') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) && !interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                    return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can manage the treasury.", ephemeral: true });
                }
                const target = options.getUser('user');
                const amount = options.getInteger('amount');
                await addUserCoins(target.id, amount, guild.id);
                
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "💸 Treasury Transaction" })
                    .setTitle("Funds Granted")
                    .setDescription(`An imperial grant of **${amount}** coins has been issued.`)
                    .addFields({ name: '👤 Recipient', value: `<@${target.id}>`, inline: true })
                    .setColor(0x2ECC71)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/2454/2454282.png')
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'removemoney') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) && !interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                    return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can manage the treasury.", ephemeral: true });
                }
                const target = options.getUser('user');
                const amount = options.getInteger('amount');
                await addUserCoins(target.id, -amount, guild.id);

                const embed = new EmbedBuilder()
                    .setAuthor({ name: "💸 Treasury Transaction" })
                    .setTitle("Funds Revoked")
                    .setDescription(`A penalty of **${amount}** coins has been deducted.`)
                    .addFields({ name: '👤 Target', value: `<@${target.id}>`, inline: true })
                    .setColor(0xE74C3C)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/2454/2454297.png')
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }
        }

    } catch (err) {
        console.error("Interaction Error:", err);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply("⚠️ Error occurred while processing that command.").catch(() => {});
            } else {
                await interaction.reply({ content: "⚠️ Error occurred while processing that command.", ephemeral: true }).catch(() => {});
            }
        } catch (e) {}
    }
});
client.login(DISCORD_TOKEN);
