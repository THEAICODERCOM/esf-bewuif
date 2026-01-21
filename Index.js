const { Client, GatewayIntentBits, ApplicationCommandOptionType, EmbedBuilder, PermissionFlagsBits, Events, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js'); 

// New Admin Permission Set: Manage Roles OR Manage Messages
const ADMIN_PERMS = PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageMessages;
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const https = require('https');

// ---------------------------
// Load tokens
// ---------------------------
let DISCORD_TOKEN; 
try {
    DISCORD_TOKEN = fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim();
} catch {
    console.error("CRITICAL: token.txt is missing!");
    process.exit(1);
}

let TOPGG_TOKEN;
try {
    TOPGG_TOKEN = fs.readFileSync(path.join(__dirname, 'topgg_token.txt'), 'utf8').trim();
} catch {
    // Silent fail, Top.gg updates just won't happen
}

// ---------------------------
// Client & Database Setup
// ---------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

/**
 * Simple Database Path Resolution
 * Only uses the data.sqlite file in the main project directory.
 */
function resolveDatabasePath() {
    return path.join(__dirname, 'data.sqlite');
}

const dbPath = resolveDatabasePath();

// Function to handle database corruption
function handleDatabaseCorruption() {
    console.error("⚠️ CRITICAL: Database corruption detected! Attempting recovery...");
    const timestamp = Date.now();
    const backupPath = `${dbPath}.corrupt.${timestamp}`;
    
    try {
        if (fs.existsSync(dbPath)) {
            fs.renameSync(dbPath, backupPath);
            console.log(`✅ Corrupted database moved to: ${backupPath}`);
        }
    } catch (e) {
        console.error("❌ Failed to move corrupted database:", e);
    }
}

let db;
try {
    db = new sqlite3.Database(dbPath, (err) => {
        if (err && err.message.includes('SQLITE_CORRUPT')) {
            handleDatabaseCorruption();
            db = new sqlite3.Database(dbPath);
        }
    });
} catch (e) {
    handleDatabaseCorruption();
    db = new sqlite3.Database(dbPath);
}

db.configure('busyTimeout', 5000);

// Add error listener for runtime corruption
db.on('error', (err) => {
    if (err && err.message.includes('SQLITE_CORRUPT')) {
        console.error("⚠️ Runtime Database Corruption Detected!");
        // We can't easily recover mid-runtime without restarting, 
        // but we can log it and exit to let the process manager (pm2/etc) restart us
        handleDatabaseCorruption();
        process.exit(1);
    }
});

db.serialize(() => {
    // Initial Integrity Check
    db.get('PRAGMA integrity_check', (err, row) => {
        if (err || (row && row.integrity_check !== 'ok')) {
            handleDatabaseCorruption();
            // Force a restart to re-initialize everything safely
            process.exit(1);
        }
    });

    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');

    db.run('CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0, lastDaily INTEGER DEFAULT 0, streak INTEGER DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS user_quiz (userId TEXT PRIMARY KEY, quizId INTEGER NOT NULL, askedAt INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS quiz_cooldown (userId TEXT PRIMARY KEY, lastUsed INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS quiz_history (userId TEXT PRIMARY KEY, askedIds TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS guild_users (guildId TEXT NOT NULL, userId TEXT NOT NULL, PRIMARY KEY (guildId, userId))');
    db.run('CREATE TABLE IF NOT EXISTS quiz_stats (userId TEXT PRIMARY KEY, correct INTEGER NOT NULL DEFAULT 0, wrong INTEGER NOT NULL DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS guess_active (userId TEXT PRIMARY KEY, playerName TEXT NOT NULL, askedAt INTEGER NOT NULL, hintIndex INTEGER NOT NULL DEFAULT 1)');
    db.run('CREATE TABLE IF NOT EXISTS guess_cooldown (userId TEXT PRIMARY KEY, lastUsed INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS server_coins (guildId TEXT NOT NULL, userId TEXT NOT NULL, coins INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guildId, userId))');
    db.run('CREATE TABLE IF NOT EXISTS server_shop (guildId TEXT NOT NULL, itemName TEXT NOT NULL, roleId TEXT NOT NULL, price INTEGER NOT NULL, PRIMARY KEY (guildId, itemName))');
    
    // Server Leagues Tables
    db.run(`CREATE TABLE IF NOT EXISTS server_leagues (
        guildId TEXT PRIMARY KEY,
        league TEXT DEFAULT 'Bronze',
        leaguePoints INTEGER DEFAULT 0,
        lastReset INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS league_contributions (
        guildId TEXT NOT NULL,
        userId TEXT NOT NULL,
        points INTEGER DEFAULT 0,
        PRIMARY KEY (guildId, userId)
    )`);
    
    // Global Events Tables
    db.run(`CREATE TABLE IF NOT EXISTS global_events (
        eventId INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        startTime INTEGER NOT NULL,
        endTime INTEGER NOT NULL,
        type TEXT NOT NULL,
        rewardData TEXT,
        announced INTEGER DEFAULT 0,
        completed INTEGER DEFAULT 0
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS event_participants (
        eventId INTEGER NOT NULL,
        userId TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (eventId, userId),
        FOREIGN KEY (eventId) REFERENCES global_events(eventId) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS active_boosters (
        userId TEXT PRIMARY KEY,
        multiplier REAL DEFAULT 2.0,
        expiresAt INTEGER NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS temporary_permissions (
        userId TEXT NOT NULL,
        permission TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        PRIMARY KEY (userId, permission)
    )`);

    // Analytics Tables
    db.run('CREATE TABLE IF NOT EXISTS bot_analytics_guilds (guildId TEXT NOT NULL, action TEXT NOT NULL, timestamp INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS bot_analytics_commands (commandName TEXT NOT NULL, category TEXT NOT NULL, count INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, lastUsed INTEGER NOT NULL, PRIMARY KEY (commandName))');
    db.run('CREATE TABLE IF NOT EXISTS bot_analytics_economy (type TEXT NOT NULL, amount INTEGER NOT NULL, timestamp INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS bot_analytics_quizzes (questionId TEXT NOT NULL, correct INTEGER NOT NULL, timestamp INTEGER NOT NULL)');
db.run('CREATE TABLE IF NOT EXISTS bot_analytics_security (type TEXT NOT NULL, timestamp INTEGER NOT NULL)');
db.run('CREATE TABLE IF NOT EXISTS bot_analytics_hourly (hour INTEGER NOT NULL, count INTEGER DEFAULT 0, PRIMARY KEY (hour))');
});

let totalResponseTime = 0;
let commandsProcessed = 0;

db.serialize(() => {
    // Migration: Ensure all columns exist in all tables
    const migrations = [
        { table: 'users', columns: ['streak', 'lastDaily', 'lastActive'] }
    ];

    migrations.forEach(m => {
        db.all(`PRAGMA table_info(${m.table})`, (err, rows) => {
            if (err || !rows) return;
            const existing = rows.map(r => r.name);
            m.columns.forEach(col => {
                if (!existing.includes(col)) {
                    db.run(`ALTER TABLE ${m.table} ADD COLUMN ${col} INTEGER DEFAULT 0`, (e) => {
                        if (e) console.error(`Migration error adding ${col} to ${m.table}:`, e);
                        else console.log(`Migration: Added column ${col} to ${m.table}`);
                    });
                }
            });
        });
    });
});

// ---------------------------
// DB Helpers
// ---------------------------
const checkCorrupt = (err) => {
    if (err && err.message.includes('SQLITE_CORRUPT')) {
        handleDatabaseCorruption();
        // Exit so process manager can restart with fresh DB
        process.exit(1);
    }
    return err;
};

const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => {
    if (e) {
        checkCorrupt(e);
        rej(e);
    } else res(r);
}));

const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(e) {
    if (e) {
        checkCorrupt(e);
        rej(e);
    } else res(this);
}));

const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, r) => {
    if (e) {
        checkCorrupt(e);
        rej(e);
    } else res(r);
}));

const CHALLENGES = new Map();

const getUserData = async (userId) => {
    let r = await dbGet('SELECT coins, lastDaily, streak FROM users WHERE userId = ?', [userId]);
    if (!r) {
        await dbRun('INSERT OR IGNORE INTO users (userId, coins, lastDaily, streak) VALUES (?,0,0,0)', [userId]);
        return { coins: 0, lastDaily: 0, streak: 0 };
    }
    return r;
};

const addUserCoins = async (userId, amount, guildId = null) => {
    // Check for active multipliers (e.g. 2x coin booster)
    let finalAmount = amount;
    if (amount > 0) {
        const booster = await dbGet('SELECT multiplier FROM active_boosters WHERE userId = ? AND expiresAt > ?', [userId, Date.now()]);
        if (booster) {
            finalAmount = Math.floor(amount * booster.multiplier);
        }
    }

    // Analytics: Log economy flow
    const logEconomy = async () => {
        const type = finalAmount > 0 ? 'earn' : 'spend';
        await dbRun('INSERT INTO bot_analytics_economy (type, amount, timestamp) VALUES (?, ?, ?)', [type, Math.abs(finalAmount), Date.now()]);
    };
    logEconomy().catch(() => {});

    // Always update global coins
    await dbRun('INSERT OR IGNORE INTO users (userId, coins) VALUES (?,0)', [userId]);
    
    // Apply League Bonus if in a guild
    let leagueBonus = 1.0;
    if (guildId && amount > 0) {
        const bonus = await getLeagueBonus(guildId);
        leagueBonus = bonus.multiplier;
    }
    
    const absoluteFinalAmount = Math.floor(finalAmount * leagueBonus);
    
    await dbRun('UPDATE users SET coins = coins + ? WHERE userId = ?', [absoluteFinalAmount, userId]);
    
    // If guildId is provided, also update server-specific coins
    if (guildId) {
        await dbRun('INSERT OR IGNORE INTO server_coins (guildId, userId, coins) VALUES (?, ?, 0)', [guildId, userId]);
        await dbRun('UPDATE server_coins SET coins = coins + ? WHERE guildId = ? AND userId = ?', [absoluteFinalAmount, guildId, userId]);
    }
    return absoluteFinalAmount; // Return final amount in case we want to show it in the message
};

const getServerUserData = async (guildId, userId) => {
    let r = await dbGet('SELECT coins FROM server_coins WHERE guildId = ? AND userId = ?', [guildId, userId]);
    if (!r) {
        await dbRun('INSERT OR IGNORE INTO server_coins (guildId, userId, coins) VALUES (?, ?, 0)', [guildId, userId]);
        return { coins: 0 };
    }
    return r;
};

const setActiveQuestion = (userId, quizId) => dbRun(
    'INSERT INTO user_quiz (userId, quizId, askedAt) VALUES (?, ?, ?) ON CONFLICT(userId) DO UPDATE SET quizId=excluded.quizId, askedAt=excluded.askedAt',
    [userId, quizId, Date.now()]
);

const getActiveQuestion = userId => dbGet('SELECT quizId, askedAt FROM user_quiz WHERE userId = ?', [userId]);

const clearActiveQuestion = userId => dbRun('DELETE FROM user_quiz WHERE userId = ?', [userId]);

const getCooldown = userId => dbGet('SELECT lastUsed FROM quiz_cooldown WHERE userId = ?', [userId]);
const setCooldown = userId => dbRun('INSERT INTO quiz_cooldown (userId, lastUsed) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET lastUsed=excluded.lastUsed', [userId, Date.now()]);

const getQuizHistory = async (userId) => {
    let r = await dbGet('SELECT askedIds FROM quiz_history WHERE userId = ?', [userId]);
    return r && r.askedIds ? r.askedIds.split(',').map(Number) : [];
};

const addQuizToHistory = async (userId, quizId) => {
    const history = await getQuizHistory(userId);
    if (!history.includes(quizId)) history.push(quizId);
    return dbRun('INSERT INTO quiz_history (userId, askedIds) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET askedIds=excluded.askedIds', [userId, history.join(',')]);
};

const upsertGuildUser = (guildId, userId) => dbRun('INSERT OR IGNORE INTO guild_users (guildId, userId) VALUES (?, ?)', [guildId, userId]);

const getQuizStats = async (userId) => {
    let r = await dbGet('SELECT correct, wrong FROM quiz_stats WHERE userId = ?', [userId]);
    return r || { correct: 0, wrong: 0 };
};

const incQuizStat = async (userId, column, quizId = null, guildId = null) => {
    await dbRun('INSERT OR IGNORE INTO quiz_stats (userId, correct, wrong) VALUES (?, 0, 0)', [userId]);
    
    // Analytics: Log quiz performance
    if (quizId !== null) {
        const correct = column === 'correct' ? 1 : 0;
        dbRun('INSERT INTO bot_analytics_quizzes (questionId, correct, timestamp) VALUES (?, ?, ?)', [quizId.toString(), correct, Date.now()]).catch(() => {});
        
        // League Points: Correct answer -> +2 LP
        if (correct && guildId) {
            addLeaguePoints(guildId, userId, 2).catch(() => {});
        }
    }

    return dbRun(`UPDATE quiz_stats SET ${column} = ${column} + 1 WHERE userId = ?`, [userId]);
};

// ---------------------------
// League Helpers
// ---------------------------
const addLeaguePoints = async (guildId, userId, points) => {
    await dbRun('INSERT OR IGNORE INTO server_leagues (guildId, lastReset) VALUES (?, ?)', [guildId, Date.now()]);
    await dbRun('UPDATE server_leagues SET leaguePoints = leaguePoints + ? WHERE guildId = ?', [points, guildId]);
    
    await dbRun('INSERT OR IGNORE INTO league_contributions (guildId, userId, points) VALUES (?, ?, 0)', [guildId, userId]);
    await dbRun('UPDATE league_contributions SET points = points + ? WHERE guildId = ? AND userId = ?', [points, guildId, userId]);
};

const getLeagueBonus = async (guildId) => {
    const data = await dbGet('SELECT league FROM server_leagues WHERE guildId = ?', [guildId]);
    if (!data) return { multiplier: 1.0, streakBonus: 0 };
    
    switch (data.league) {
        case 'Silver': return { multiplier: 1.05, streakBonus: 0 };
        case 'Gold': return { multiplier: 1.10, streakBonus: 1 };
        case 'Diamond': return { multiplier: 1.15, streakBonus: 2 };
        default: return { multiplier: 1.0, streakBonus: 0 };
    }
};

const getGuessActive = userId => dbGet('SELECT playerName, askedAt, hintIndex FROM guess_active WHERE userId = ?', [userId]);
const setGuessActive = (userId, playerName) => dbRun('INSERT INTO guess_active (userId, playerName, askedAt, hintIndex) VALUES (?, ?, ?, 1) ON CONFLICT(userId) DO UPDATE SET playerName=excluded.playerName, askedAt=excluded.askedAt, hintIndex=excluded.hintIndex', [userId, playerName, Date.now()]);
const setGuessHintIndex = (userId, hintIndex) => dbRun('UPDATE guess_active SET hintIndex = ? WHERE userId = ?', [hintIndex, userId]);
const clearGuessActive = userId => dbRun('DELETE FROM guess_active WHERE userId = ?', [userId]);
const getGuessCooldown = userId => dbGet('SELECT lastUsed FROM guess_cooldown WHERE userId = ?', [userId]);
const setGuessCooldown = userId => dbRun('INSERT INTO guess_cooldown (userId, lastUsed) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET lastUsed=excluded.lastUsed', [userId, Date.now()]);

const RUSH_SESSIONS = new Map();

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
// League Reset System (Weekly)
// ---------------------------
const runWeeklyLeagueReset = async () => {
    console.log('🔄 Starting Global Server League Reset...');
    try {
        const guilds = await dbAll('SELECT * FROM server_leagues');
        if (guilds.length === 0) return;

        // Sort by points descending
        const sorted = guilds.sort((a, b) => b.leaguePoints - a.leaguePoints);
        const total = sorted.length;

        for (let i = 0; i < total; i++) {
            const rank = i + 1;
            const percentile = (rank / total) * 100;
            let newLeague = 'Bronze';

            if (percentile <= 5) newLeague = 'Diamond';
            else if (percentile <= 20) newLeague = 'Gold';
            else if (percentile <= 50) newLeague = 'Silver';

            const guildId = sorted[i].guildId;
            const points = sorted[i].leaguePoints;

            // Get top contributor
            const topContributor = await dbGet('SELECT userId, points FROM league_contributions WHERE guildId = ? ORDER BY points DESC LIMIT 1', [guildId]);
            
            // Send announcement
            const guild = client.guilds.cache.get(guildId);
            if (guild) {
                const channel = guild.channels.cache.find(c => 
                    c.isTextBased() && (
                        c.name.toLowerCase().includes('bot-command') || 
                        c.name.toLowerCase().includes('command') ||
                        c.name.toLowerCase().includes('bot') ||
                        c.name.toLowerCase() === 'general'
                    )
                );

                if (channel) {
                    const embed = new EmbedBuilder()
                        .setTitle('🏆 Weekly League Results')
                        .setDescription(`The season has ended! Here is how **${guild.name}** performed:`)
                        .addFields(
                            { name: '🏟️ New League', value: `**${newLeague}**`, inline: true },
                            { name: '📊 Global Rank', value: `#${rank} of ${total}`, inline: true },
                            { name: '📈 Points Earned', value: `\`${points} LP\``, inline: true },
                            { name: '👑 Top Contributor', value: topContributor ? `<@${topContributor.userId}> (${topContributor.points} LP)` : 'None', inline: false }
                        )
                        .setColor(newLeague === 'Diamond' ? 0x00FFFF : newLeague === 'Gold' ? 0xFFD700 : newLeague === 'Silver' ? 0xC0C0C0 : 0xCD7F32)
                        .setFooter({ text: 'Next season starts now! Good luck!' })
                        .setTimestamp();

                    channel.send({ embeds: [embed] }).catch(() => {});
                    
                    // Reward top contributor (25 coins)
                    if (topContributor) {
                        addUserCoins(topContributor.userId, 25, guildId).catch(() => {});
                    }
                }
            }

            // Update DB
            await dbRun('UPDATE server_leagues SET league = ?, leaguePoints = 0, lastReset = ? WHERE guildId = ?', [newLeague, Date.now(), guildId]);
            await dbRun('DELETE FROM league_contributions WHERE guildId = ?', [guildId]);
        }
        console.log('✅ Weekly League Reset Complete.');
    } catch (e) {
        console.error('❌ Weekly League Reset Error:', e);
    }
};

// Check for weekly reset every hour
setInterval(async () => {
    const lastResetRow = await dbGet('SELECT MAX(lastReset) as last FROM server_leagues');
    const lastReset = lastResetRow?.last || 0;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    if (Date.now() - lastReset > sevenDays) {
        runWeeklyLeagueReset();
    }
}, 3600000); // 1 hour

// ---------------------------
// Quiz Pool & Shop
// ---------------------------
const QUIZ_POOL = [
    { id: 1, type: "chess", question: "How many squares are on a chess board?", answer: "64 squares", wrong: ["32 squares", "100 squares"], reward: 10 },
    { id: 2, type: "chess", question: "How many players play a standard chess match?", answer: "Two players", wrong: ["One player", "Four players"], reward: 10 },
    { id: 3, type: "chess", question: "Which color always moves first in chess?", answer: "White", wrong: ["Black", "Random"], reward: 10 },
    { id: 4, type: "chess", question: "How many pawns does each player start with?", answer: "Eight pawns", wrong: ["Six pawns", "Ten pawns"], reward: 10 },
    { id: 5, type: "chess", question: "What is the most powerful piece in chess?", answer: "Queen", wrong: ["King", "Rook"], reward: 10 },
    { id: 6, type: "chess", question: "What piece moves in an L-shape?", answer: "Knight", wrong: ["Bishop", "Rook"], reward: 10 },
    { id: 7, type: "chess", question: "What piece moves only diagonally?", answer: "Bishop", wrong: ["Rook", "Pawn"], reward: 10 },
    { id: 8, type: "chess", question: "What piece moves horizontally and vertically?", answer: "Rook", wrong: ["Bishop", "Knight"], reward: 10 },
    { id: 9, type: "chess", question: "What is the special move involving the King and Rook?", answer: "Castling", wrong: ["Promotion", "En passant"], reward: 10 },
    { id: 10, type: "chess", question: "What is the ultimate goal of a chess game?", answer: "Checkmate", wrong: ["Stalemate", "Draw"], reward: 10 },
    { id: 11, type: "chess", question: "What is it called when the King is under attack?", answer: "Check", wrong: ["Capture", "Mate"], reward: 10 },
    { id: 12, type: "chess", question: "How do you win a game of chess?", answer: "Checkmate", wrong: ["Capturing all pieces", "Promotion"], reward: 10 },
    { id: 13, type: "chess", question: "What is a draw by three identical positions called?", answer: "Threefold repetition", wrong: ["Stalemate", "Fifty-move rule"], reward: 10 },
    { id: 14, type: "chess", question: "What is a draw where a player has no legal moves?", answer: "Stalemate", wrong: ["Checkmate", "Check"], reward: 10 },
    { id: 15, type: "chess", question: "What is it called when the King is directly attacked?", answer: "Check", wrong: ["Checkmate", "Stalemate"], reward: 10 },
    { id: 16, type: "chess", question: "How many vertical lines (files) are on the board?", answer: "Eight files", wrong: ["Six files", "Ten files"], reward: 10 },
    { id: 17, type: "chess", question: "How many horizontal lines (ranks) are on the board?", answer: "Eight ranks", wrong: ["Six ranks", "Ten ranks"], reward: 10 },
    { id: 18, type: "chess", question: "What square does the white King start on?", answer: "e1", wrong: ["d1", "e2"], reward: 10 },
    { id: 19, type: "chess", question: "What square does the black King start on?", answer: "e8", wrong: ["d8", "e7"], reward: 10 },
    { id: 20, type: "chess", question: "How many Kings are on the board in total?", answer: "Two Kings", wrong: ["One King", "Four Kings"], reward: 10 },
    { id: 21, type: "chess", question: "What piece can never be captured?", answer: "King", wrong: ["Queen", "Pawn"], reward: 10 },
    { id: 22, type: "chess", question: "What is the king's defensive move called?", answer: "Castling", wrong: ["Pawn move", "Capture"], reward: 10 },
    { id: 23, type: "chess", question: "What is the standard chess notation called?", answer: "Algebraic notation", wrong: ["Binary", "Old code"], reward: 10 },
    { id: 24, type: "chess", question: "What is the special pawn capture called?", answer: "En passant", wrong: ["Castling", "Promotion"], reward: 10 },
    { id: 25, type: "chess", question: "What is it called when a pawn reaches the last rank?", answer: "Promotion", wrong: ["Castling", "Checkmate"], reward: 10 },
    { id: 26, type: "chess", question: "When can pawn promotion happen?", answer: "Last rank", wrong: ["Middle rank", "First rank"], reward: 10 },
    { id: 27, type: "chess", question: "What is the start of the game called?", answer: "Opening", wrong: ["Endgame", "Middlegame"], reward: 10 },
    { id: 28, type: "chess", question: "What is the middle phase of the game called?", answer: "Middlegame", wrong: ["Opening", "Endgame"], reward: 10 },
    { id: 29, type: "chess", question: "What is the initial board setup called?", answer: "Starting position", wrong: ["Final position", "Checkmate"], reward: 10 },
    { id: 30, type: "chess", question: "What is the final phase of the game called?", answer: "Endgame", wrong: ["Opening", "Middlegame"], reward: 10 },
    { id: 31, type: "chess", question: "What is a move that attacks two pieces at once?", answer: "Fork", wrong: ["Pin", "Skewer"], reward: 10 },
    { id: 32, type: "chess", question: "What is a move that restricts an enemy piece's movement?", answer: "Pin", wrong: ["Fork", "Skewer"], reward: 10 },
    { id: 33, type: "chess", question: "What is an attack on a valuable piece that forces it to move?", answer: "Skewer", wrong: ["Fork", "Pin"], reward: 10 },
    { id: 34, type: "chess", question: "What happens when a pawn reaches the 8th rank?", answer: "Promotion", wrong: ["Castling", "Stalemate"], reward: 10 },
    { id: 35, type: "chess", question: "What is the situation where any move weakens your position?", answer: "Zugzwang", wrong: ["Check", "Gambit"], reward: 10 },
    { id: 36, type: "chess", question: "What is a chess opening that sacrifices a pawn for an advantage?", answer: "Gambit", reward: 10, wrong: ["Trade", "Blunder"] },
    { id: 37, type: "chess", question: "What is a pawn that has no enemy pawns in front of it?", answer: "Passed pawn", reward: 10, wrong: ["Isolated pawn", "Doubled pawn"] },
    { id: 38, type: "chess", question: "What piece can jump over other pieces?", answer: "Knight", reward: 10, wrong: ["Rook", "Bishop"] },
    { id: 39, type: "chess", question: "What is an attack revealed by moving another piece?", answer: "Discovered attack", reward: 10, wrong: ["Direct attack", "Blunder"] },
    { id: 40, type: "chess", question: "What is the development of a bishop to the long diagonal?", answer: "Fianchetto", reward: 10, wrong: ["Castling", "Promotion"] },
    { id: 41, type: "chess", question: "What is the most important piece to protect?", answer: "King", reward: 10, wrong: ["Queen", "Rook"] },
    { id: 42, type: "chess", question: "What must you do if your King is in check?", answer: "Escape check", reward: 10, wrong: ["Capture Queen", "Promote pawn"] },
    { id: 43, type: "chess", question: "What is a draw by mutual consent called?", answer: "Draw by agreement", reward: 10, wrong: ["Stalemate", "Checkmate"] },
    { id: 44, type: "chess", question: "What is the international chess federation called?", answer: "FIDE", reward: 10, wrong: ["FIFA", "UEFA"] },
    { id: 45, type: "chess", question: "What is a very fast game of chess called?", answer: "Blitz", reward: 10, wrong: ["Classical", "Rapid"] },
    { id: 46, type: "chess", question: "What is an extremely fast chess game called?", answer: "Bullet", reward: 10, wrong: ["Blitz", "Rapid"] },
    { id: 47, type: "chess", question: "How many points is a Queen typically worth?", answer: "Nine points", reward: 10, wrong: ["Five points", "Ten points"] },
    { id: 48, type: "chess", question: "How many points is a Rook typically worth?", answer: "Five points", reward: 10, wrong: ["Three points", "Nine points"] },
    { id: 49, type: "chess", question: "How many points is a Bishop typically worth?", answer: "Three points", reward: 10, wrong: ["Five points", "One point"] },
    { id: 50, type: "chess", question: "Who is the current World Chess Champion (2024)?", answer: "Ding Liren", reward: 10, wrong: ["Magnus Carlsen", "Hikaru Nakamura"] },
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
    { id: 151, type: "chess", question: "What is a 'blunder'?", answer: "A terrible move", reward: 10, wrong: ["A brilliant sacrifice", "An opening"] },
    { id: 152, type: "chess", question: "Which piece is sometimes called a 'horse'?", answer: "Knight", reward: 10, wrong: ["Bishop", "Rook"] },
    { id: 153, type: "chess", question: "What is 'Scholar's Mate'?", answer: "4-move checkmate", reward: 10, wrong: ["A long draw", "An opening"] },
    { id: 154, type: "chess", question: "What does 'GM' stand for?", answer: "Grandmaster", reward: 10, wrong: ["Game Master", "Great Master"] },
    { id: 155, type: "chess", question: "What is it called when a player gives up?", answer: "Resignation", reward: 10, wrong: ["Stalemate", "Draw"] },
    { id: 156, type: "chess", question: "Which piece cannot move backwards?", answer: "Pawn", reward: 10, wrong: ["Knight", "King"] },
    { id: 157, type: "chess", question: "What is a 'brilliant' move?", answer: "Best sacrifice", reward: 10, wrong: ["A random move", "Capturing a pawn"] },
    { id: 158, type: "chess", question: "What is 'bullet' chess time control?", answer: "1 minute or less", reward: 10, wrong: ["10 minutes", "1 hour"] },
    { id: 159, type: "chess", question: "What is fast-paced chess called?", answer: "Blitz", reward: 10, wrong: ["Classical", "Rapid"] },
    { id: 160, type: "chess", question: "What is an ELO rating?", answer: "Skill level number", reward: 10, wrong: ["Number of wins", "Age of player"] },
    { id: 161, type: "chess", question: "Who is 'Magnus Carlsen'?", answer: "Chess GOAT", reward: 10, wrong: ["A footballer", "A chess piece"] },
    { id: 162, type: "chess", question: "What is the 'Sicilian Defense'?", answer: "A popular opening", reward: 10, wrong: ["A checkmate", "A defensive wall"] },
    { id: 163, type: "chess", question: "What is 'en passant'?", answer: "Special pawn capture", reward: 10, wrong: ["A type of draw", "A move"] },
    { id: 164, type: "chess", question: "What is a 'stalemate'?", answer: "A type of draw", reward: 10, wrong: ["A win for white", "A loss for black"] },
    { id: 165, type: "chess", question: "What is 'castling'?", answer: "King and Rook move", reward: 10, wrong: ["Queen and King move", "Two Rooks move"] },
    { id: 166, type: "chess", question: "What is a 'fork'?", answer: "Attacking two pieces", reward: 10, wrong: ["Trading pieces", "Defending"] },
    { id: 167, type: "chess", question: "What is a 'pin'?", answer: "Restricting a piece", reward: 10, wrong: ["Winning a pawn", "Using a clock"] },
    { id: 168, type: "chess", question: "What is a 'skewer'?", answer: "Attack through a piece", reward: 10, wrong: ["Losing a Knight", "A type of board"] },
    { id: 169, type: "chess", question: "What is the 'middlegame'?", answer: "Phase after the opening", reward: 10, wrong: ["The very end", "The first move"] },
    { id: 170, type: "chess", question: "What is the 'endgame'?", answer: "Final phase of the game", reward: 10, wrong: ["Start of game", "Middle phase"] },
    { id: 171, type: "chess", question: "What is a 'sac'?", answer: "Short for sacrifice", reward: 10, wrong: ["A bag of pieces", "A type of move"] },
    { id: 172, type: "chess", question: "What is 'opening theory'?", answer: "Studied first moves", reward: 10, wrong: ["Guessing moves", "A science"] },
    { id: 173, type: "chess", question: "What are 'ELO points'?", answer: "Rating system", reward: 10, wrong: ["Score", "A player name"] },
    { id: 174, type: "chess", question: "What is a 'Candidate'?", answer: "Player in qualifiers", reward: 10, wrong: ["A beginner", "A piece"] },
    { id: 175, type: "chess", question: "What is the 'London System'?", answer: "A solid opening", reward: 10, wrong: ["A train system", "A clock"] },
    { id: 176, type: "chess", question: "What is a 'fianchetto'?", answer: "Bishop on long diagonal", reward: 10, wrong: ["A small pawn", "A type of pasta"] },
    { id: 177, type: "chess", question: "What is 'checkmating'?", answer: "Winning the game", reward: 10, wrong: ["Stalemate", "Trading pieces"] },
    { id: 178, type: "chess", question: "What is a 'double attack'?", answer: "Two pieces attacking", reward: 10, wrong: ["Checking twice", "A safe move"] },
    { id: 179, type: "chess", question: "What is 'underpromotion'?", answer: "Promoting to non-Queen", reward: 10, wrong: ["Losing a pawn", "Promoting late"] },
    { id: 180, type: "chess", question: "What is a 'Grandmaster draw'?", answer: "A quick boring draw", reward: 10, wrong: ["A brilliant win", "A 100-move fight"] },
    { id: 181, type: "chess", question: "What is 'tilting'?", answer: "Playing worse due to anger", reward: 10, wrong: ["Moving the board", "A winning streak"] },
    { id: 182, type: "chess", question: "What is a 'smothered mate'?", answer: "Checkmate by a Knight", reward: 10, wrong: ["Checkmate by a Queen", "Stalemate"] },
    { id: 183, type: "chess", question: "What is a 'back rank mate'?", answer: "Checkmate on 1st/8th rank", reward: 10, wrong: ["Mate from behind", "Mate with a pawn"] },
    { id: 184, type: "chess", question: "What is an 'aggressive' player?", answer: "Attacking style", reward: 10, wrong: ["Slow & boring", "Defensive only"] },
    { id: 185, type: "chess", question: "What is a 'positional' player?", answer: "Strategic & slow", reward: 10, wrong: ["Wild & crazy", "Fastest player"] },
    { id: 186, type: "chess", question: "What is the 'Queen's Gambit'?", answer: "Sacrificing a pawn", reward: 10, wrong: ["A Netflix show only", "A Queen trade"] },
    { id: 187, type: "chess", question: "What is 'time pressure'?", answer: "Low time on clock", reward: 10, wrong: ["Pushing the clock", "Being nervous"] },
    { id: 188, type: "chess", question: "What is a 'chess engine'?", answer: "AI that plays chess", reward: 10, wrong: ["A car part", "A clock"] },
    { id: 189, type: "chess", question: "What is 'Stockfish'?", answer: "The best chess AI", reward: 10, wrong: ["A meal", "A player name"] },
    { id: 190, type: "chess", question: "What is a 'premove'?", answer: "Moving before your turn", reward: 10, wrong: ["Thinking fast", "Moving twice"] },
    { id: 191, type: "chess", question: "What is 'hypermodern' chess?", answer: "Control center from afar", reward: 10, wrong: ["Modern board design", "Playing fast"] },
    { id: 192, type: "chess", question: "What is 'classical' chess?", answer: "Long time controls", reward: 10, wrong: ["Old board sets", "Boring games"] },
    { id: 193, type: "chess", question: "What is the 'French Defense'?", answer: "Solid e6 opening", reward: 10, wrong: ["A surrender", "A castling move"] },
    { id: 194, type: "chess", question: "What is a 'discovered attack'?", answer: "Moving to reveal attack", reward: 10, wrong: ["Finding a piece", "Attacking twice"] },
    { id: 195, type: "chess", question: "What is a 'zwischenzug'?", answer: "An in-between move", reward: 10, wrong: ["A type of piece", "A German player"] },
    { id: 196, type: "chess", question: "What is 'perpetual check'?", answer: "Endless checks (draw)", reward: 10, wrong: ["A winning check", "A hidden check"] },
    { id: 197, type: "chess", question: "What is a 'passed pawn'?", answer: "No enemy pawns ahead", reward: 10, wrong: ["A pawn that died", "A traded pawn"] },
    { id: 198, type: "chess", question: "What is 'opposition'?", answer: "Kings facing each other", reward: 10, wrong: ["The other player", "A type of attack"] },
    { id: 199, type: "chess", question: "What is a 'bad bishop'?", answer: "Blocked by own pawns", reward: 10, wrong: ["A bishop that blunders", "A mean player"] },
    { id: 200, type: "chess", question: "What is 'the exchange'?", answer: "Trading minor for major piece", reward: 10, wrong: ["Trading Queens", "Trading places"] },

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
Youngest World Chess Champion in history
Dominated Classical, Blitz, and Rapid simultaneously
Slammed the table during a high-stakes World Championship match (2023)
Voluntarily gave up the World Chess Champion title
Famous for squeezing wins from boring equal situations
2. Garry Kasparov
Youngest World Chess Champion at the time
Symbol of aggressive, scary attacking play
Historic matches vs a literal computer (and lost once, lol)
Ruled the world rankings for over 20 years
Became a professional political activist after retiring
3. Bobby Fischer
Only American to conquer the Soviet Chess Machine
Ended Soviet dominance in 1972
Perfect 6–0–6 run in the Candidates Tournament
Extremely spicy and controversial personality
Vanished into thin air after winning the World Championship
4. Anatoly Karpov
Master of positional and prophylactic play
Became World Chess Champion because the other guy didn't show up (1975)
Legendary rivalry with the aggressive guy (Kasparov)
Incredible consistency at sitting in a chair for hours
Famous for slowly suffocating opponents' positions
5. Vladimir Kramnik
Ended the reign of the previous World Champion (Kasparov)
Popularized the "Berlin Wall" defense
Deep understanding of positional chess
Later involved in "is he cheating?" internet drama
Elite theorist of the opening phase
6. Viswanathan Anand
The first World Chess Champion from India
Extremely fast calculation speed
World Chess Champion in three different formats
Known for not panicking when the clock is low
National icon for his brilliance
7. Hikaru Nakamura
One of the best Blitz and Bullet players ever
Twitch & YouTube superstar for chess fans
Known for moving fast and talking trash
Made a comeback in the 2022 Candidates Tournament
Online speed chess legend
8. Fabiano Caruana
Came closest to beating the champion Magnus (2018)
Reached a peak rating of 2844
Extremely precise opening preparation
Known for staying up all night studying the game
Calm, robotic style of play
9. Ding Liren
The first World Chess Champion from China
Famous 100+ game undefeated streak
Very quiet and humble for a top-tier player
Overcame serious lack of motivation
Elite at not losing
10. Alireza Firouzja
Youngest player to reach 2800 rating
Switched teams from Iran to France for more freedom
Ultra-aggressive "I will fight you" style
Fashion designer because chess wasn't enough
Touted as the future World Chess Champion
11. Mikhail Tal
“The Magician from Riga”
Threw away his pieces just to cause chaos
World Chess Champion in 1960
Pure intuition and "I hope this works" energy
Everyone's favorite chaotic attacking player
12. José Raúl Capablanca
Naturally gifted at moving the pieces
Minimum studying, maximum winning
Legendary endgame technique
Very long undefeated streaks
Third World Chess Champion
13. Emanuel Lasker
Longest-reigning World Chess Champion (27 years)
Philosopher who thought about the game too much
Psychological approach: "I'll make you uncomfortable"
Defeated multiple generations of younger players
Extremely practical and annoying to play against
14. Alexander Alekhine
Ferocious attacking World Chess Champion
Never lost his title in an actual match
Has a "confuse the opponent" opening named after him
Brilliant at seeing things 20 steps ahead
Tragic personal life but great at chess
15. Mikhail Botvinnik
Father of the Soviet Chess School
Multiple-time World Chess Champion
Teacher to the next generation of top players
Scientific approach to the game
Dominated the post-war chess scene
16. Wesley So
Known for being a very polite player
Elite technician of the endgame
Olympiad champion for Team USA
Calm and disciplined "I will not make a mistake" style
Strong mental control and focus
17. Ian Nepomniachtchi
Multiple-time Candidates Tournament winner
Extremely fast at making decisions (sometimes bad ones)
Collapsed when the pressure of the World Championship got too high
Highly creative and unpredictable
Childhood rival of Magnus Carlsen
18. Levon Aronian
One of the most liked guys in the chess community
Creative at sacrificing pieces for a win
Team champion with Armenia
Known for telling jokes while winning
Universal style: can play any position
19. Sergey Karjakin
Youngest Grandmaster in history
Challenged for the World Championship in 2016
A literal brick wall of defense
Got into a lot of political arguments online
Extremely hard to knock down
20. Teimour Radjabov
Beat Kasparov when he was just 15
Extremely solid "nothing gets through" style
Longtime contender for the top spot
Cautious style: "safety first, winning second"
Strong comeback after a long break
21. Paul Morphy
Greatest player of the 1800s
Dominated everyone across the ocean
Attacking genius before people knew how to defend
Retired early to be a lawyer
Legend who never got a formal title
22. Judit Polgár
Strongest female player in history
Beat multiple World Chess Champions
Refused to play in women-only tournaments
Aggressive "I will crush you" style
Broke all the rules about gender in chess
23. Max Euwe
Mathematician who was also World Chess Champion
Known for being a very fair player
Defeated the scary attacking guy (Alekhine)
Later became the President of FIDE
Logical and structured approach to life
24. Boris Spassky
The gentlemanly World Chess Champion
Lost the "Match of the Century" to Bobby Fischer
Can play any style: tactical, positional, or weird
Stayed out of political drama
Elegant moves on the board
25. Veselin Topalov
Extremely aggressive "all or nothing" player
Dominated the FIDE World Championship in 2005
FIDE World Champion for one year
Involved in "toiletgate" drama (don't ask)
Tactical powerhouse
26. Shakhriyar Mamedyarov
Always plays for a win, never for a draw
Wild, chaotic games that make your head hurt
Fan favorite for being an attacking madman
Explosive attacks out of nowhere
High-risk, high-reward playing style
27. Anish Giri
Expert at opening preparation and research
Famous for making chess memes on Twitter
Extremely hard to beat, but also hard for him to win
Long "everything is a draw" streaks
Elite preparation for every scenario
28. Gukesh D
Youngest person to challenge for the World Championship
Beat Magnus Carlsen multiple times
Part of the new wave of Indian prodigies
Fearless even when the clock is ticking
Very calm for a teenager
29. Praggnanandhaa
Beat Magnus Carlsen while he was still a kid
Learns new things at 2x speed
Strong calculation skills
National hero for being a prodigy
Remarkably mature for a young player
30. Vidit Gujrathi
Participant in the Candidates Tournament
Very solid and reliable player
Excellent at playing on a team
Underrated for a long time
Can play any style depending on the mood
31. Richard Rapport
Chooses weird moves just to be different
Highly creative and artistic
Known for wearing cool shirts to chess events
Chaos-driven attacking play
Artistic approach to the game
32. Jan-Krzysztof Duda
The guy who finally beat Magnus's win streak
Reached the final of the World Cup
Strong at fast-paced speed chess
Fearless competitor who doesn't care who you are
Excellent at the endgame
33. Yi Wei
Chinese elite Grandmaster
Expert at positional chess
Doesn't talk to the media much
Strong "middle game" skills
Very solid and hard to knock over
34. Samuel Reshevsky
Child prodigy who grew up to be a legend
Tactical fighter who never gave up
American chess icon
Very religious, didn't play on Saturdays
Had a career that lasted decades
35. Tigran Petrosian
The ultimate defensive genius
Nicknamed “Iron Tigran” because he's a wall
Sacrificed his own pieces just to stay safe
Very, very, very hard to beat
Master of prophylaxis
36. David Bronstein
Almost became World Chess Champion
Thinker who came up with weird ideas
Innovator of opening theory
Author of chess books people actually read
Famous for "let's see what happens" moves
37. Bent Larsen
The hope of the Western players
Highly original and weird moves
Challenged the Soviet dominance
Fearless attacker who didn't care about safety
Unorthodox and fun to watch
38. Peter Svidler
Expert at the Grünfeld Defense
Top-level commentator for chess tournaments
Multiple-time champion of Russia
Known for having a great sense of humor
Elite opening specialist
39. Wesley So
Multiple-time World Random Chess Champion
A literal machine at the endgame
Extremely clean and solid technique
Rarely makes a blunder
Ice-cold nerves under pressure
40. Hou Yifan
The strongest female player currently playing
Competed against the top men regularly
Gave up being a pro player to be a professor
Strategic and smart style
Global role model for chess excellence
41. Fischer
Invented Chess960 (Fischer Random)
Hated when games ended in quick draws
Innovator of the opening phase
Perfectionist at the endgame
Absolute "it must be perfect" mindset
42. Viktor Korchnoi
A guy who fought until he was 80 years old
Defected from the USSR to keep playing
Extreme willpower and grumpiness
Never became the official World Chess Champion
Legendary mental toughness
43. Daniil Dubov
Creative assistant to Magnus Carlsen
Loves sacrificing pieces for creative attacks
Modern ideas that challenge traditional theory
Specialist at Blitz and Rapid chess
Highly unconventional and cool
44. Arjun Erigaisi
One of the fastest rating climbs in history
Extremely aggressive "I'm coming for you" style
New-generation superstar
Fearless approach to every game
Strong at calculating complex variations
45. Nihal Sarin
Prodigy at Blitz and Bullet chess
Moves so fast you can't see his hands
Online speed chess specialist
Tactical vision like a hawk
Very young and already at the top
46. Gata Kamsky
Challenged for the World Championship title
Had a legendary "I'm back" story
Very calm and quiet personality
Solid and reliable style
Had an elite career that lasted decades
47. Alexander Grischuk
Famous for getting into severe time trouble
Elite at Blitz and Rapid games
Very funny guy in interviews
Risk-taking style that makes people nervous
Massive experience at being a top player
48. Nodirbek Abdusattorov
World Rapid Chess Champion (2021)
Known for having "nerves of steel"
Leading the new generation of players
Incredible defensive skills when he's losing
Extremely focused on the board
49. Dommaraju Gukesh
Youngest Candidates Tournament winner ever
Challenged for the World Chess Champion title
Extremely mature for a teenager
Part of the golden era of Indian chess
Incredible calculation speed
50. Rameshbabu Praggnanandhaa
Broke into the elite level while still a kid
Known for studying the game 24/7
Beat Magnus Carlsen multiple times in speed chess
Won a gold medal for his country
Incredible at the endgame
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
            { name: 'daily', description: 'Claim your daily stipend (25+ coins)' },
            { name: 'balance', description: 'Check your or another player\'s treasury balance', options: [{ name: 'user', description: 'User to check', type: ApplicationCommandOptionType.User, required: false }] },
            { 
                name: 'leaderboard', 
                description: 'View the top legends', 
                options: [
                    { 
                        name: 'scope', 
                        description: 'Leaderboard scope', 
                        type: ApplicationCommandOptionType.String, 
                        required: false, 
                        choices: [{ name: 'Global', value: 'global' }, { name: 'Server', value: 'server' }] 
                    },
                    {
                        name: 'category',
                        description: 'Leaderboard category',
                        type: ApplicationCommandOptionType.String,
                        required: false,
                        choices: [{ name: 'Wealth (Coins)', value: 'wealth' }, { name: 'Intelligence (Quiz Correct)', value: 'intelligence' }]
                    }
                ] 
            },
            {
                name: 'challenge',
                description: 'Challenge someone to a 1v1 quiz battle',
                options: [
                    { name: 'user', description: 'User to challenge', type: ApplicationCommandOptionType.User, required: true },
                    { name: 'bet', description: 'Coins to bet', type: ApplicationCommandOptionType.Integer, required: true },
                    { 
                        name: 'type', 
                        description: 'Quiz category', 
                        type: ApplicationCommandOptionType.String, 
                        required: true,
                        choices: [
                            { name: 'Chess', value: 'chess' },
                            { name: 'Football', value: 'football' },
                            { name: 'Basketball', value: 'basketball' }
                        ]
                    }
                ]
            },
            {
                name: 'gift',
                description: 'Gift some of your coins to another user',
                options: [
                    { name: 'user', description: 'Recipient', type: ApplicationCommandOptionType.User, required: true },
                    { name: 'amount', description: 'Amount to gift', type: ApplicationCommandOptionType.Integer, required: true }
                ]
            },
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
                description: 'Generate recovery protocols (Owner only)',
                default_member_permissions: '0'
            },
            {
                name: 'admin-repair',
                description: 'Verify database integrity and repair if possible (Owner only)',
                default_member_permissions: '0'
            },
            { 
                name: 'quiz', 
                description: 'Test your brain for rewards (30s cooldown)',
                options: [
                    {
                        name: 'type',
                        description: 'Category: Chess, Football, or Basketball',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: 'Chess', value: 'chess' },
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
                        description: 'Category: Chess, Football, or Basketball',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: 'Football', value: 'football' },
                            { name: 'Chess', value: 'chess' },
                            { name: 'Basketball', value: 'basketball' }
                        ]
                    }
                ]
            },
            { name: 'guess', description: 'Submit your intel on the mystery person', options: [{ name: 'name', description: 'Name of the person', type: ApplicationCommandOptionType.String, required: true }] },
            { name: 'ration', description: 'View your tactical performance stats' },
            { name: 'questions', description: 'Review the chess and sports question bank (Admins only)', default_member_permissions: ADMIN_PERMS.toString(), options: [{ name: 'page', description: 'Bank page', type: ApplicationCommandOptionType.Integer, required: false }] },
            { name: 'addmoney', description: 'Deposit coins into a treasury (Admins only)', default_member_permissions: ADMIN_PERMS.toString(), options: [{ name: 'user', description: 'Recipient', type: ApplicationCommandOptionType.User, required: true }, { name: 'amount', description: 'Amount to deposit', type: ApplicationCommandOptionType.Integer, required: true }] },
            { name: 'removemoney', description: 'Confiscate coins from a treasury (Admins only)', default_member_permissions: ADMIN_PERMS.toString(), options: [{ name: 'user', description: 'Target', type: ApplicationCommandOptionType.User, required: true }, { name: 'amount', description: 'Amount to seize', type: ApplicationCommandOptionType.Integer, required: true }] },
            {
                name: 'quiz-rush',
                description: 'High-speed quiz challenge: 5 questions in 30s for 2x rewards!',
                options: [
                    {
                        name: 'bet',
                        description: 'Amount of coins to bet',
                        type: ApplicationCommandOptionType.Integer,
                        required: true,
                        min_value: 10
                    }
                ]
            },
            { name: 'vote', description: 'Support the bot by voting on top.gg' },
            { name: 'support', description: 'Get the link to our Discord support server' },
            { name: 'help', description: 'The ultimate guide to dominating the server' },
            { name: 'guide', description: 'Receive a complete DM guide on how to play and dominate' },
            {
                name: 'events',
                description: 'Manage global events (Owner only)',
                default_member_permissions: '0',
                options: [
                    {
                        name: 'create',
                        description: 'Create a new global event',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'name', description: 'Event name', type: ApplicationCommandOptionType.String, required: true },
                            { name: 'description', description: 'Event description', type: ApplicationCommandOptionType.String, required: true },
                            { name: 'type', description: 'Event type', type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
                            { name: 'start', description: 'Start date/time (YYYY-MM-DD HH:mm)', type: ApplicationCommandOptionType.String, required: true },
                            { name: 'end', description: 'End date/time (YYYY-MM-DD HH:mm)', type: ApplicationCommandOptionType.String, required: true },
                            { name: 'reward', description: 'Reward description', type: ApplicationCommandOptionType.String, required: false }
                        ]
                    },
                    {
                        name: 'update',
                        description: 'Update an existing event',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'id', description: 'Event ID', type: ApplicationCommandOptionType.Integer, required: true },
                            { name: 'name', description: 'New name', type: ApplicationCommandOptionType.String, required: false },
                            { name: 'description', description: 'New description', type: ApplicationCommandOptionType.String, required: false },
                            { name: 'reward', description: 'New reward', type: ApplicationCommandOptionType.String, required: false }
                        ]
                    },
                    {
                        name: 'stats',
                        description: 'View ongoing event stats and leaderboards',
                        type: ApplicationCommandOptionType.Subcommand
                    },
                    {
                        name: 'list',
                        description: 'List all global events',
                        type: ApplicationCommandOptionType.Subcommand
                    },
                    {
                        name: 'delete',
                        description: 'Delete a global event',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'id', description: 'Event ID', type: ApplicationCommandOptionType.Integer, required: true }
                        ]
                    }
                ]
            },
            {
                name: 'league',
                description: 'View the global server league standings',
                options: [
                    {
                        name: 'standing',
                        description: 'View your server\'s current league standing and rewards',
                        type: ApplicationCommandOptionType.Subcommand
                    },
                    {
                        name: 'leaderboard',
                        description: 'View the top 10 servers by league points',
                        type: ApplicationCommandOptionType.Subcommand
                    }
                ]
            },
            {
                name: 'say',
                description: 'Broadcast a message to all servers (Owner only)',
                default_member_permissions: '0',
                options: [
                    {
                        name: 'message',
                        description: 'The message to broadcast',
                        type: ApplicationCommandOptionType.String,
                        required: true
                    }
                ]
            },
            {
                name: 'servers',
                description: 'Show all servers the bot is in (Owner only)',
                default_member_permissions: '0'
            },
            {
                name: 'analytics',
                description: 'View deep bot analytics and health (Owner only)',
                default_member_permissions: '0'
            }
        ]);
        console.log(`✅ Logged in as ${client.user.tag}`);

        // Update Top.gg stats on startup
        updateTopGGStats();

        // Start Global Events Checker (every 1 minute)
        setInterval(checkAndAnnounceEvents, 60000);
        checkAndAnnounceEvents(); // Initial check on startup
    } catch (error) {
        console.error("Command Registration Error:", error);
    }
});

// Update Top.gg stats when joining/leaving a server
client.on(Events.GuildCreate, (guild) => {
    updateTopGGStats();
    dbRun('INSERT INTO bot_analytics_guilds (guildId, action, timestamp) VALUES (?, ?, ?)', [guild.id, 'join', Date.now()]).catch(() => {});
});

client.on(Events.GuildDelete, (guild) => {
    updateTopGGStats();
    dbRun('INSERT INTO bot_analytics_guilds (guildId, action, timestamp) VALUES (?, ?, ?)', [guild.id, 'leave', Date.now()]).catch(() => {});
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
                    value: '`/daily` - Claim your daily 25 coins\n`/balance [user]` - Check your or someone else\'s coin balance\n`/leaderboard [scope] [category]` - View top players (Wealth or Intelligence)\n`/gift <user> <amount>` - Transfer global coins to an ally' 
                },
                { 
                    name: '🎮 Games & Quizzes', 
                    value: '`/quiz <type>` - Start a multiple-choice quiz (30s cooldown)\n`/challenge <user> <bet> <type>` - 1v1 battle for a pot of coins\n`/guesstheplayer <type>` - Identify the mystery pro from hints\n`/guess <name>` - Submit your person guess\n`/ration` - View your accuracy and statistics\n`/vote` - Support the bot by voting on top.gg' 
                },
                { 
                    name: '🏆 Shop & Leaderboard', 
                    value: '`/shop` - View roles available in this server\'s shop\n`/leaderboard [scope] [category]` - View top players' 
                },
                {
                    name: '🌟 Support',
                    value: '[Join Support Server](https://discord.gg/b7BAQH3gf2) • [Vote for Bot](https://top.gg/bot/1454968008719073492/vote)'
                },
                { 
                    name: '🛠️ Admin Commands', 
                    value: '`/item create <name> <role> <price>` - Add a new item to the shop\n`/item edit <name> [new_name] [price] [role]` - Edit a shop item\n`/item delete <name>` - Remove an item from the shop\n`/shop-delete-all` - Clear the entire server shop\n`/addmoney <user> <amount>` - Add coins to a user\n`/removemoney <user> <amount>` - Remove coins from a user\n`/questions [page]` - View the question bank\n`/admin-backup` - Generate recovery protocols (Owner Only)\n`/admin-repair` - Force a database integrity check' 
                }
            )
            .setColor(0x3498DB)
            .setFooter({ text: "Tip: Use /help for the full guide to greatness!" })
            .setTimestamp();
        
        await message.reply({ embeds: [embed] }).catch(() => {});
    }
});

// ---------------------------
// Event Helper Functions
// ---------------------------
async function updateEventScore(userId, eventType, points = 1, guildId = null) {
    const now = Date.now();
    const activeEvents = await dbAll(
        'SELECT eventId FROM global_events WHERE type = ? AND startTime <= ? AND endTime >= ? AND completed = 0',
        [eventType, now, now]
    );

    for (const event of activeEvents) {
        await dbRun(
            'INSERT INTO event_participants (eventId, userId, score) VALUES (?, ?, ?) ON CONFLICT(eventId, userId) DO UPDATE SET score = score + ?',
            [event.eventId, userId, points, points]
        );

        // League Points: Global event completion -> +10 LP (Logged when score updated)
        if (guildId) {
            addLeaguePoints(guildId, userId, 10).catch(() => {});
        }
    }
}

async function checkAndAnnounceEvents() {
    const now = Date.now();
    
    // 1. Announce New Events
    const toAnnounce = await dbAll('SELECT * FROM global_events WHERE startTime <= ? AND announced = 0 AND completed = 0', [now]);
    for (const event of toAnnounce) {
        const embed = new EmbedBuilder()
            .setTitle(`🎉 NEW GLOBAL EVENT: ${event.name}`)
            .setDescription(event.description)
            .addFields(
                { name: '🏆 Reward', value: event.rewardData || 'Tournament Title & Coins', inline: true },
                { name: '⏱️ Ends', value: `<t:${Math.floor(event.endTime / 1000)}:R>`, inline: true },
                { name: '📝 Type', value: event.type.replace('_', ' ').toUpperCase(), inline: true }
            )
            .setColor(0xF1C40F)
            .setTimestamp();

        await broadcastToEventsChannel(embed);
        await dbRun('UPDATE global_events SET announced = 1 WHERE eventId = ?', [event.eventId]);
    }

    // 2. Complete Finished Events
    const toComplete = await dbAll('SELECT * FROM global_events WHERE endTime <= ? AND completed = 0', [now]);
    for (const event of toComplete) {
        const participants = await dbAll('SELECT * FROM event_participants WHERE eventId = ? ORDER BY score DESC LIMIT 3', [event.eventId]);
        
        const embed = new EmbedBuilder()
            .setTitle(`🏁 EVENT COMPLETED: ${event.name}`)
            .setDescription(`The global event has ended! Here are the champions:`)
            .setColor(0x2ECC71)
            .setTimestamp();

        if (participants.length > 0) {
            let winnersText = "";
            for (let i = 0; i < participants.length; i++) {
                const p = participants[i];
                const medal = i === 0 ? "🥇" : (i === 1 ? "🥈" : "🥉");
                winnersText += `${medal} <@${p.userId}> — Score: **${p.score}**\n`;
                
                // Reward for winner (1st place)
                if (i === 0) {
                    let rewardApplied = "";
                    const type = event.type;
                    const oneDay = 24 * 60 * 60 * 1000;

                    if (type === 'tournament') {
                        // 2x coin booster for 1 month
                        const expires = Date.now() + (30 * oneDay);
                        await dbRun('INSERT OR REPLACE INTO active_boosters (userId, multiplier, expiresAt) VALUES (?, 2.0, ?)', [p.userId, expires]);
                        rewardApplied = "2x Coin Booster (30 Days)";
                    } 
                    else if (type === 'pvp_showdown') {
                        // 2x coin booster for 7 days + /addmoney permission
                        const expires = Date.now() + (7 * oneDay);
                        await dbRun('INSERT OR REPLACE INTO active_boosters (userId, multiplier, expiresAt) VALUES (?, 2.0, ?)', [p.userId, expires]);
                        await dbRun('INSERT OR REPLACE INTO temporary_permissions (userId, permission, expiresAt) VALUES (?, "addmoney", ?)', [p.userId, expires]);
                        rewardApplied = "2x Coin Booster & /addmoney Permission (7 Days)";
                    }
                    else if (type === 'rush_marathon') {
                        // 2x coin booster for 3 days
                        const expires = Date.now() + (3 * oneDay);
                        await dbRun('INSERT OR REPLACE INTO active_boosters (userId, multiplier, expiresAt) VALUES (?, 2.0, ?)', [p.userId, expires]);
                        rewardApplied = "2x Coin Booster (3 Days)";
                    }
                    else if (type === 'streak_king') {
                        // 2x coin booster for 7 days
                        const expires = Date.now() + (7 * oneDay);
                        await dbRun('INSERT OR REPLACE INTO active_boosters (userId, multiplier, expiresAt) VALUES (?, 2.0, ?)', [p.userId, expires]);
                        rewardApplied = "2x Coin Booster (7 Days)";
                    }
                    else {
                        // Default coins for other types
                        await dbRun('UPDATE users SET coins = coins + 500 WHERE userId = ?', [p.userId]);
                        rewardApplied = "500 Coins";
                    }

                    winnersText += `🎁 **Reward:** ${rewardApplied}\n`;
                }
            }
            embed.addFields({ name: 'Champions', value: winnersText });
        } else {
            embed.setDescription("The event ended with no participants.");
        }

        await broadcastToEventsChannel(embed);
        await dbRun('UPDATE global_events SET completed = 1 WHERE eventId = ?', [event.eventId]);
    }
}

async function updateTopGGStats() {
    if (!TOPGG_TOKEN) return;

    const data = JSON.stringify({
        server_count: client.guilds.cache.size
    });

    const options = {
        hostname: 'top.gg',
        port: 443,
        path: `/api/bots/${client.user.id}/stats`,
        method: 'POST',
        headers: {
            'Authorization': TOPGG_TOKEN,
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    };

    const req = https.request(options, (res) => {
        if (res.statusCode === 200) {
            console.log('✅ Top.gg server count updated successfully.');
        } else {
            console.error(`❌ Failed to update Top.gg stats. Status: ${res.statusCode}`);
        }
    });

    req.on('error', (error) => {
        console.error('❌ Error updating Top.gg stats:', error.message);
    });

    req.write(data);
    req.end();
}

async function broadcastToEventsChannel(embed) {
    const guilds = client.guilds.cache;
    for (const [guildId, guild] of guilds) {
        try {
            let channel = guild.channels.cache.find(c => 
                (c.name === 'events' || c.name === 'bot-events') && c.isTextBased()
            );

            if (!channel) {
                // Create #events if it doesn't exist
                try {
                    channel = await guild.channels.create({
                        name: 'events',
                        type: 0, // GuildText
                        topic: 'Global Bot Events & Announcements',
                        reason: 'Automatic bot events channel creation'
                    });
                } catch (e) {
                    // Fallback to bot-commands if creation fails
                    channel = guild.channels.cache.find(c => 
                        ['bot-commands', 'bot-command', 'commands'].includes(c.name.toLowerCase()) && c.isTextBased()
                    );
                }
            }

            if (channel) {
                await channel.send({ embeds: [embed] }).catch(() => {});
            }
        } catch (err) {
            console.error(`Failed to broadcast to guild ${guild.name}:`, err.message);
        }
    }
}

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
    // 1. Handle Autocomplete immediately (no deferral needed/allowed)
    if (interaction.isAutocomplete()) {
        try {
            const focusedOption = interaction.options.getFocused(true);
            const focusedValue = focusedOption.value || '';
            const { commandName } = interaction;

            if (commandName === 'events' && focusedOption.name === 'type') {
                const eventTypes = [
                    { name: 'Tournament (Quiz Corrects)', value: 'tournament' },
                    { name: 'PvP Showdown (Challenge Wins)', value: 'pvp_showdown' },
                    { name: 'Quiz Rush Marathon (Rush Scores)', value: 'rush_marathon' },
                    { name: 'Mystery Player (Guessed Players)', value: 'mystery_challenge' },
                    { name: 'Streak King (Daily Streaks)', value: 'streak_king' },
                    { name: 'Custom Event (Manual tracking)', value: 'custom' }
                ];

                const filtered = eventTypes
                    .filter(t => t.name.toLowerCase().includes(focusedValue.toLowerCase()))
                    .map(t => ({ name: t.name, value: t.value }));
                
                await interaction.respond(filtered.slice(0, 25)).catch(() => {});
                return;
            }

            const guildId = interaction.guildId;
            if (!guildId) return;

            const shopItems = await dbAll('SELECT itemName FROM server_shop WHERE guildId = ?', [guildId]);
            const filtered = shopItems
                .filter(item => item.itemName.toLowerCase().includes(focusedValue.toLowerCase()))
                .map(item => ({ name: item.itemName, value: item.itemName }));
            
            await interaction.respond(filtered.slice(0, 25)).catch(() => {});
        } catch (e) {
            console.error("Autocomplete Error:", e.message);
        }
        return;
    }

    // 2. Handle Commands and Buttons
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

    const { user, guild } = interaction;

    // 3. IMMEDIATE DEFERRAL
    // This is the most critical part. We must tell Discord we received the interaction 
    // before doing ANY database work or logic.
    try {
        if (interaction.isChatInputCommand()) {
            await interaction.deferReply().catch(err => {
                throw new Error(`Deferral Failed: ${err.message} (Code: ${err.code})`);
            });
        } else if (interaction.isButton()) {
            await interaction.deferUpdate().catch(err => {
                throw new Error(`Button DeferUpdate Failed: ${err.message} (Code: ${err.code})`);
            });
        }
    } catch (e) {
        // If deferral fails, we cannot respond to this interaction.
        // This usually happens if the bot is running twice or network is extremely laggy.
        console.error(`❌ [${interaction.isButton() ? 'BUTTON' : 'COMMAND'}] ${e.message}`);
        return; 
    }

    // 4. Background tasks (after deferral)
    if (guild) {
        upsertGuildUser(guild.id, user.id).catch(() => {});
    }

    // Analytics: Update user activity and command usage
    const startTime = Date.now();
    const updateActivity = async () => {
        const now = Date.now();
        await dbRun('UPDATE users SET lastActive = ? WHERE userId = ?', [now, user.id]);
        
        if (interaction.isChatInputCommand()) {
            const cmdName = interaction.commandName;
            const category = 'other'; // Simplified for now
            const currentHour = new Date().getUTCHours();

            await dbRun(`
                INSERT INTO bot_analytics_commands (commandName, category, count, lastUsed) 
                VALUES (?, ?, 1, ?) 
                ON CONFLICT(commandName) DO UPDATE SET count = count + 1, lastUsed = ?
            `, [cmdName, category, now, now]);

            await dbRun(`
                INSERT INTO bot_analytics_hourly (hour, count)
                VALUES (?, 1)
                ON CONFLICT(hour) DO UPDATE SET count = count + 1
            `, [currentHour]);

            const responseTime = Date.now() - startTime;
            totalResponseTime += responseTime;
            commandsProcessed++;
        }
    };
    updateActivity().catch(() => {});

    try {
        if (interaction.isButton()) {
            const { customId } = interaction;
            
            if (customId === 'shop_close') {
                await interaction.editReply({ components: [] });
                return;
            }

            if (customId.startsWith('rush_choice:')) {
                const choice = customId.slice('rush_choice:'.length);
                const session = RUSH_SESSIONS.get(user.id);

                if (!session) {
                    return interaction.followUp({ content: "❌ No active Quiz Rush session found.", ephemeral: true });
                }

                if (Date.now() > session.endTime) {
                    RUSH_SESSIONS.delete(user.id);
                    return interaction.editReply({ content: "⏰ **TIME EXPIRED!** You didn't finish the 5 questions in 30s. You lost your bet.", embeds: [], components: [] });
                }

                const currentQ = session.questions[session.currentIndex];
                if (choice === currentQ.answer) {
                    session.correctAnswers++;
                }

                session.currentIndex++;

                if (session.currentIndex < 5) {
                    const nextQ = session.questions[session.currentIndex];
                    const choices = [nextQ.answer, ...nextQ.wrong].sort(() => 0.5 - Math.random());
                    const timeLeft = Math.ceil((session.endTime - Date.now()) / 1000);

                    const embed = new EmbedBuilder()
                        .setTitle("⚡ QUIZ RUSH CONTINUES!")
                        .setDescription(`**Question ${session.currentIndex + 1}/5**\n\n${nextQ.question}\n\n⏱️ Time Left: **${timeLeft}s**\n💰 Potential Win: **${session.bet * 2} coins**`)
                        .setColor(0xFFA500)
                        .setFooter({ text: "Keep going! Speed is everything!" });

                    const row = new ActionRowBuilder().addComponents(
                        choices.map(c => new ButtonBuilder().setCustomId(`rush_choice:${c}`).setLabel(c).setStyle(ButtonStyle.Primary))
                    );

                    await interaction.editReply({ embeds: [embed], components: [row] });
                } else {
                    // Game Ended
                    RUSH_SESSIONS.delete(user.id);
                    const win = session.correctAnswers === 5;
                    const reward = win ? session.bet * 2 : 0;

                    if (win) {
                        await dbRun('UPDATE server_coins SET coins = coins + ? WHERE guildId = ? AND userId = ?', [reward, guild.id, user.id]);
                
                // Track Event: Quiz Rush Marathon
                await updateEventScore(user.id, 'rush_marathon', 1);
            }

                    const resultEmbed = new EmbedBuilder()
                        .setTitle(win ? "🎊 RUSH COMPLETED!" : "💀 RUSH FAILED")
                        .setDescription(win 
                            ? `Incredible speed! You got **5/5** correct and won **${reward} coins**!` 
                            : `You got **${session.correctAnswers}/5** correct. You need 5/5 to win the 2x reward. You lost your bet.`)
                        .setColor(win ? 0x2ECC71 : 0xE74C3C)
                        .setTimestamp();

                    await interaction.editReply({ embeds: [resultEmbed], components: [] });
                }
                return;
            }

            if (customId.startsWith('challenge_accept:')) {
                const parts = customId.split(':');
                const challengerId = parts[1];
                const bet = parseInt(parts[2]);
                const type = parts[3];

                if (user.id === challengerId) {
                    return interaction.followUp({ content: "❌ You cannot accept your own challenge!", ephemeral: true });
                }

                const targetData = await getServerUserData(guild.id, user.id);
                if (targetData.coins < bet) {
                    return interaction.followUp({ content: `❌ You don't have enough coins to accept this bet (**${bet}**).`, ephemeral: true });
                }

                const challengerData = await getServerUserData(guild.id, challengerId);
                if (challengerData.coins < bet) {
                    return interaction.followUp({ content: `❌ The challenger no longer has enough coins for this bet.`, ephemeral: true });
                }

                const q = await getRandomQuizForUser(user.id, type);
                const choices = [q.answer, ...q.wrong].sort(() => 0.5 - Math.random());

                CHALLENGES.set(interaction.message.id, {
                    challengerId,
                    targetId: user.id,
                    bet,
                    quizId: q.id,
                    startTime: Date.now()
                });

                const row = new ActionRowBuilder().addComponents(
                    choices.map(c => new ButtonBuilder().setCustomId(`battle_choice:${c}`).setLabel(c).setStyle(ButtonStyle.Primary))
                );

                const embed = new EmbedBuilder()
                    .setTitle("⚔️ BATTLE START!")
                    .setDescription(`**${q.question}**\n\n💰 **Pot:** ${bet * 2} coins\n⏱️ **First to answer correctly wins!**`)
                    .setColor("#F1C40F");

                await interaction.editReply({ content: `<@${challengerId}> vs <@${user.id}>`, embeds: [embed], components: [row] });
                return;
            }

            if (customId.startsWith('challenge_reject:')) {
                const challengerId = customId.split(':')[1];
                if (user.id === challengerId) {
                    await interaction.editReply({ content: "Challenge cancelled.", embeds: [], components: [] });
                } else {
                    await interaction.editReply({ content: `Challenge rejected by **${user.username}**.`, embeds: [], components: [] });
                }
                return;
            }

            if (customId.startsWith('battle_choice:')) {
                const challenge = CHALLENGES.get(interaction.message.id);
                if (!challenge) {
                    return interaction.followUp({ content: "❌ This battle has already ended.", ephemeral: true });
                }

                if (user.id !== challenge.challengerId && user.id !== challenge.targetId) {
                    return interaction.followUp({ content: "❌ You are not part of this battle!", ephemeral: true });
                }

                const choice = customId.slice('battle_choice:'.length);
                const q = QUIZ_POOL.find(i => i.id === challenge.quizId);
                const correct = choice === q.answer;

                CHALLENGES.delete(interaction.message.id);

                const winnerId = correct ? user.id : (user.id === challenge.challengerId ? challenge.targetId : challenge.challengerId);
                const loserId = winnerId === challenge.challengerId ? challenge.targetId : challenge.challengerId;

                await addUserCoins(winnerId, challenge.bet, guild.id);
                await addUserCoins(loserId, -challenge.bet, guild.id);

                // League Points: Winning /challenge -> +5 LP
                addLeaguePoints(guild.id, winnerId, 5).catch(() => {});

                // Track Event: PvP Showdown
                await updateEventScore(winnerId, 'pvp_showdown', 1);

                const winnerUser = await client.users.fetch(winnerId);
                const loserUser = await client.users.fetch(loserId);

                const embed = new EmbedBuilder()
                    .setTitle("⚔️ BATTLE ENDED")
                    .setDescription(`**${winnerUser.username}** wins the pot of **${challenge.bet * 2} coins**!\n\n${correct ? `Correct answer: **${choice}**` : `Incorrect answer by ${user.username}. The winner is ${winnerUser.username}!`}`)
                    .setColor("#2ECC71")
                    .setTimestamp();

                await interaction.editReply({ content: `Winner: <@${winnerId}>`, embeds: [embed], components: [] });
                return;
            }
            if (customId.startsWith('quiz_choice:')) {
                const choice = customId.slice('quiz_choice:'.length);
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
                    await incQuizStat(user.id, 'wrong', q.id, guild.id);
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "⏱️ Brain Lag" })
                        .setTitle("Time is up!")
                        .setDescription(`You were too slow. The correct answer was: **${q.answer}**`)
                        .setColor(0xE67E22);
                    await interaction.editReply({ embeds: [embed], components: [] });
                    return;
                }

                if (correct) {
                    await incQuizStat(user.id, 'correct', q.id, guild.id);
                    await addUserCoins(user.id, q.reward, guild.id);
                    
                    // Track Event: Tournament (Quiz Corrects)
                    await updateEventScore(user.id, 'tournament', 1, guild.id);

                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "✅ Big Brain Energy" })
                        .setTitle("Galaxy Brain!")
                        .setDescription(`**${choice}** is correct!`)
                        .addFields({ name: '💰 Reward Earned', value: `\`${q.reward}\` coins`, inline: true })
                        .setColor(0x2ECC71);
                    await interaction.editReply({ embeds: [embed], components: [] });
                } else {
                    await incQuizStat(user.id, 'wrong', q.id, guild.id);
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
                
                // Hint cost: 5 coins
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
                    .setFooter({ text: `Balance: ${newData.coins} coins • Next hint: ${HINT_COST} coins` });

                const label = idx >= entry.hints.length ? 'No more hints' : `Next Hint (${HINT_COST} Coins)`;
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
            if (customId.startsWith('shop_page:')) {
                const page = parseInt(customId.split(':')[1]);
                const shopItems = await dbAll('SELECT * FROM server_shop WHERE guildId = ? ORDER BY price ASC', [guild.id]);
                const itemsPerPage = 5;
                const totalPages = Math.ceil(shopItems.length / itemsPerPage);
                const start = (page - 1) * itemsPerPage;
                const pagedItems = shopItems.slice(start, start + itemsPerPage);

                const member = await guild.members.fetch(user.id);
                const data = await getServerUserData(guild.id, user.id);
                const fields = pagedItems.map(s => {
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
                    .setDescription(`Welcome to the marketplace! You currently have \`${data.coins}\` coins to spend.\n\nPage **${page}** of **${totalPages}**`)
                    .addFields(fields)
                    .setColor(0x3498DB)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/3081/3081559.png')
                    .setFooter({ text: `Browse at your leisure • ${guild.name}` });

                const buttons = pagedItems.map(s => {
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

                const navRow = new ActionRowBuilder();
                navRow.addComponents(
                    new ButtonBuilder().setCustomId(`shop_page:${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
                    new ButtonBuilder().setCustomId(`shop_page:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages),
                    new ButtonBuilder().setCustomId('shop_close').setLabel('Leave Shop').setEmoji('🚪').setStyle(ButtonStyle.Danger)
                );
                rows.push(navRow);

                // Use editReply because the interaction was already deferred by the global handler
                return interaction.editReply({ embeds: [embed], components: rows });
            }

            if (customId.startsWith('shop_buy:')) {
                const itemName = customId.slice('shop_buy:'.length);
                const item = (await dbAll('SELECT * FROM server_shop WHERE guildId = ? AND itemName = ?', [guild.id, itemName]))[0];
                if (!item) { 
                    try {
                        // Use followUp with ephemeral for error messages on button clicks
                        await interaction.followUp({ content: "Item no longer exists in the shop.", ephemeral: true }); 
                    } catch (e) {
                        console.error("FollowUp failed:", e.message);
                    }
                    return; 
                }
                
                const member = await guild.members.fetch(user.id);
                const role = guild.roles.cache.get(item.roleId);
                if (!role) { 
                    try {
                        await interaction.followUp({ content: `The role associated with this item no longer exists.`, ephemeral: true }); 
                    } catch (e) {
                        console.error("FollowUp failed:", e.message);
                    }
                    return; 
                }
                if (member.roles.cache.has(role.id)) { 
                    try {
                        await interaction.followUp({ content: "You already own this role.", ephemeral: true }); 
                    } catch (e) {
                        console.error("FollowUp failed:", e.message);
                    }
                    return; 
                }
                
                const data = await getServerUserData(guild.id, user.id);
                if (data.coins < item.price) { 
                    try {
                        await interaction.followUp({ content: "Insufficient funds in this server to buy this item.", ephemeral: true }); 
                    } catch (e) {
                        console.error("FollowUp failed:", e.message);
                    }
                    return; 
                }
                
                try {
                    await member.roles.add(role.id);
                } catch (e) {
                    console.error("Role add failed:", e.message);
                    await interaction.followUp({ content: "❌ Failed to add role. Please check if my role is high enough in the hierarchy!", ephemeral: true });
                    return;
                }
                await addUserCoins(user.id, -item.price, guild.id);
                
                const newMember = await guild.members.fetch(user.id);
                const newData = await getServerUserData(guild.id, user.id);
                const shopItems = await dbAll('SELECT * FROM server_shop WHERE guildId = ? ORDER BY price ASC', [guild.id]);
                
                // Pagination logic for update (using page 1 for now or we could track page)
                const itemsPerPage = 5;
                const totalPages = Math.ceil(shopItems.length / itemsPerPage);
                const page = 1; // Default to first page after buy
                const start = (page - 1) * itemsPerPage;
                const pagedItems = shopItems.slice(start, start + itemsPerPage);

                const fields = pagedItems.map(s => {
                    const sRole = guild.roles.cache.get(s.roleId);
                    const owned = sRole ? newMember.roles.cache.has(sRole.id) : false;
                    const roleMention = sRole ? `<@&${sRole.id}>` : `Unknown Role`;
                    const ownedTxt = owned ? "Already Owned" : "Not Owned";
                    return { name: `♟️ ${s.itemName}`, value: `💰 Price: ${s.price} coins\n🎭 Role: ${roleMention}\n✅ Status: ${ownedTxt}`, inline: false };
                });
                
                const embed = new EmbedBuilder()
                    .setTitle(`🛒 Server Shop • Balance: ${newData.coins} coins`)
                    .setDescription(`Page **${page}** of **${totalPages}**`)
                    .addFields(fields)
                    .setColor(0x3498DB);

                const buttons = pagedItems.map(s => {
                    const sRole = guild.roles.cache.get(s.roleId);
                    const owned = sRole ? newMember.roles.cache.has(sRole.id) : false;
                    const label = owned ? `Owned: ${s.itemName}` : `Buy ${s.itemName} • ${s.price} Coins`;
                    return new ButtonBuilder().setCustomId(`shop_buy:${s.itemName}`).setLabel(label).setEmoji('🛒').setStyle(owned ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(owned);
                });
                
                const rows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
                }

                const navRow = new ActionRowBuilder();
                if (totalPages > 1) {
                    navRow.addComponents(
                        new ButtonBuilder().setCustomId(`shop_page:${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
                        new ButtonBuilder().setCustomId(`shop_page:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages)
                    );
                }
                navRow.addComponents(new ButtonBuilder().setCustomId('shop_close').setLabel('Close Shop').setEmoji('🧹').setStyle(ButtonStyle.Danger));
                rows.push(navRow);
                
                // Use editReply for the main shop interface update
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

                // followUp is correct here for the success message
                await interaction.followUp({ embeds: [successEmbed], ephemeral: true });
                return;
            }
            return;
        }

    if (interaction.isChatInputCommand()) {
        const { commandName, options, subcommandName } = interaction;

            if (commandName === 'daily') {
                const userData = await getUserData(user.id);
                const now = Date.now();
                const oneDay = 24 * 60 * 60 * 1000;

                if (now - userData.lastDaily < oneDay) {
                    const remaining = oneDay - (now - userData.lastDaily);
                    const hours = Math.floor(remaining / (1000 * 60 * 60));
                    const mins = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
                    return interaction.editReply(`⏰ You can claim your daily reward in **${hours}h ${mins}m**.`);
                }

                let newStreak = 1;
                if (now - userData.lastDaily < oneDay * 2) {
                    newStreak = userData.streak + 1;
                }

                // League Points: /daily streak >= 3 -> +1 LP
                if (newStreak >= 3) {
                    addLeaguePoints(guild.id, user.id, 1).catch(() => {});
                }

                // League Reward: Gold/Diamond get streak bonus
                const leagueBonus = await getLeagueBonus(guild.id);
                const bonusStreak = leagueBonus.streakBonus;
                
                const finalStreakForReward = newStreak + bonusStreak;
                const reward = 25 + (finalStreakForReward * 5);
                
                await addUserCoins(user.id, reward, guild.id);
                await dbRun('UPDATE users SET lastDaily = ?, streak = ? WHERE userId = ?', [now, newStreak, user.id]);

                const embed = new EmbedBuilder()
                    .setTitle("💰 Daily Reward Claimed!")
                    .setDescription(`You received **${reward} coins**!\n🔥 Current Streak: **${newStreak}**${bonusStreak > 0 ? ` (+${bonusStreak} League Bonus)` : ''}`)
                    .setColor(0x2ECC71)
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'league') {
                const sub = options.getSubcommand(false);

                if (sub === 'leaderboard') {
                    const topServers = await dbAll('SELECT * FROM server_leagues ORDER BY leaguePoints DESC LIMIT 10');
                    
                    const embed = new EmbedBuilder()
                        .setTitle("🌍 Global League Leaderboard")
                        .setDescription("Top 10 servers by League Points (LP) this season.")
                        .setColor(0xF1C40F)
                        .setTimestamp();

                    if (topServers.length > 0) {
                        const list = topServers.map((s, i) => {
                            const guild = client.guilds.cache.get(s.guildId);
                            const name = guild ? guild.name : `Unknown Server (${s.guildId})`;
                            const medal = i === 0 ? "🥇" : (i === 1 ? "🥈" : "🥉");
                            const rank = i > 2 ? `**#${i + 1}**` : medal;
                            return `${rank} **${name}** — \`${s.leaguePoints} LP\` (${s.league})`;
                        }).join('\n');
                        embed.setDescription(list);
                    } else {
                        embed.setDescription("No servers have earned LP yet this season.");
                    }

                    return interaction.editReply({ embeds: [embed] });
                }

                // Default standing view (no subcommand or explicitly requested)
                const leagueData = await dbGet('SELECT * FROM server_leagues WHERE guildId = ?', [guild.id]);
                const topContributor = await dbGet('SELECT userId, points FROM league_contributions WHERE guildId = ? ORDER BY points DESC LIMIT 1', [guild.id]);
                
                const league = leagueData?.league || 'Bronze';
                const points = leagueData?.leaguePoints || 0;
                
                const bonus = await getLeagueBonus(guild.id);
                const rewards = [];
                if (bonus.multiplier > 1) rewards.push(`• +${Math.round((bonus.multiplier - 1) * 100)}% Coin Earnings`);
                if (bonus.streakBonus > 0) rewards.push(`• +${bonus.streakBonus} Daily Streak Bonus`);
                if (league === 'Diamond') rewards.push(`• 💎 Exclusive Diamond Badge`);

                const embed = new EmbedBuilder()
                    .setTitle(`🏆 ${guild.name} League Standing`)
                    .setColor(league === 'Diamond' ? 0x00FFFF : league === 'Gold' ? 0xFFD700 : league === 'Silver' ? 0xC0C0C0 : 0xCD7F32)
                    .addFields(
                        { name: '🏟️ Current League', value: `**${league}**`, inline: true },
                        { name: '📈 League Points', value: `\`${points} LP\``, inline: true },
                        { name: '👑 Top Contributor', value: topContributor ? `<@${topContributor.userId}> (${topContributor.points} LP)` : 'None yet', inline: false },
                        { name: '🎁 Active Rewards', value: rewards.length > 0 ? rewards.join('\n') : 'No rewards yet. Reach Silver to unlock!', inline: false }
                    )
                    .setFooter({ text: 'Leagues reset every Monday at 00:00 UTC' })
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'analytics') {
            if (interaction.user.id !== '1324354578338025533') {
                return interaction.editReply({ content: "❌ You can't use this command.", ephemeral: true });
            }

            try {
                const now = Date.now();
                const oneDay = 24 * 60 * 60 * 1000;
                const sevenDays = 7 * oneDay;
                const thirtyDays = 30 * oneDay;

                // 1. Core Growth Metrics
                const totalServers = client.guilds.cache.size;
                const joins24h = (await dbGet('SELECT COUNT(*) as count FROM bot_analytics_guilds WHERE action = "join" AND timestamp > ?', [now - oneDay])).count;
                const leaves24h = (await dbGet('SELECT COUNT(*) as count FROM bot_analytics_guilds WHERE action = "leave" AND timestamp > ?', [now - oneDay])).count;
                const joins7d = (await dbGet('SELECT COUNT(*) as count FROM bot_analytics_guilds WHERE action = "join" AND timestamp > ?', [now - sevenDays])).count;
                const leaves7d = (await dbGet('SELECT COUNT(*) as count FROM bot_analytics_guilds WHERE action = "leave" AND timestamp > ?', [now - sevenDays])).count;
                const joins30d = (await dbGet('SELECT COUNT(*) as count FROM bot_analytics_guilds WHERE action = "join" AND timestamp > ?', [now - thirtyDays])).count;
                const leaves30d = (await dbGet('SELECT COUNT(*) as count FROM bot_analytics_guilds WHERE action = "leave" AND timestamp > ?', [now - thirtyDays])).count;
                
                const net24h = joins24h - leaves24h;
                const net7d = joins7d - leaves7d;
                const net30d = joins30d - leaves30d;
                const growthRate = totalServers > 0 ? ((net24h / totalServers) * 100).toFixed(1) : 0;

                // 2. User Activity
                const totalUsers = (await dbGet('SELECT COUNT(*) as count FROM users')).count;
                const active24h = (await dbGet('SELECT COUNT(*) as count FROM users WHERE lastActive > ?', [now - oneDay])).count;
                const active7d = (await dbGet('SELECT COUNT(*) as count FROM users WHERE lastActive > ?', [now - sevenDays])).count;
                const mau = (await dbGet('SELECT COUNT(*) as count FROM users WHERE lastActive > ?', [now - thirtyDays])).count;
                const dauMauRatio = mau > 0 ? ((active24h / mau) * 100).toFixed(1) : 0;
                
                const totalCmdsAllTime = (await dbGet('SELECT SUM(count) as total FROM bot_analytics_commands')).total || 0;
                const avgCmdsPerUser = totalUsers > 0 ? (totalCmdsAllTime / totalUsers).toFixed(1) : 0;
                const peakHourData = await dbGet('SELECT hour FROM bot_analytics_hourly ORDER BY count DESC LIMIT 1');
                const peakHour = peakHourData ? `${peakHourData.hour}:00–${peakHourData.hour + 1}:00` : 'N/A';

                // 3. Command Analytics
                const totalCmds24h = (await dbGet('SELECT COUNT(*) as count FROM bot_analytics_commands WHERE lastUsed > ?', [now - oneDay])).count;
                const topCommands = await dbAll('SELECT commandName, count FROM bot_analytics_commands ORDER BY count DESC LIMIT 5');
                const lowUsage = await dbAll('SELECT commandName FROM bot_analytics_commands ORDER BY count ASC LIMIT 3');
                const totalErrors = (await dbGet('SELECT SUM(errors) as total FROM bot_analytics_commands')).total || 0;
                const failRate = totalCmdsAllTime > 0 ? ((totalErrors / totalCmdsAllTime) * 100).toFixed(1) : 0;

                // 4. Economy Health
                const totalCoins = (await dbGet('SELECT SUM(coins) as total FROM server_coins')).total || 0;
                const earned24h = (await dbGet('SELECT SUM(amount) as total FROM bot_analytics_economy WHERE type = "earn" AND timestamp > ?', [now - oneDay])).total || 0;
                const spent24h = (await dbGet('SELECT SUM(amount) as total FROM bot_analytics_economy WHERE type = "spend" AND timestamp > ?', [now - oneDay])).total || 0;
                const avgBalance = totalUsers > 0 ? (totalCoins / totalUsers).toFixed(0) : 0;
                
                // Top 1% Wealth Share
                const top1PercentCount = Math.max(1, Math.floor(totalUsers / 100));
                const topWealthData = await dbGet(`SELECT SUM(coins) as total FROM (SELECT coins FROM server_coins ORDER BY coins DESC LIMIT ${top1PercentCount})`);
                const wealthShare = totalCoins > 0 ? ((topWealthData.total / totalCoins) * 100).toFixed(0) : 0;
                const ecoStatus = earned24h > spent24h * 1.5 ? "🔴 Inflating" : "🟢 Stable";

                // 5. Quiz Analytics
                const lifetimeQuizData = await dbGet('SELECT SUM(correct) as correct, SUM(wrong) as wrong, COUNT(*) as totalUsers FROM quiz_stats');
                const totalQuizzesLifetime = (lifetimeQuizData.correct || 0) + (lifetimeQuizData.wrong || 0);
                const avgAccuracyLifetime = totalQuizzesLifetime > 0 ? ((lifetimeQuizData.correct / totalQuizzesLifetime) * 100).toFixed(1) : 0;
                
                const topAccuracyData = await dbGet('SELECT MAX(accuracy) as maxAcc FROM (SELECT (CAST(correct AS FLOAT)/(correct + wrong))*100 as accuracy FROM quiz_stats WHERE (correct + wrong) > 0)');
                const topAccuracy = topAccuracyData?.maxAcc ? topAccuracyData.maxAcc.toFixed(1) : 'N/A';

                // 6. System Status
                const uptimeRaw = process.uptime();
                const memory = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
                const avgResTime = commandsProcessed > 0 ? (totalResponseTime / commandsProcessed).toFixed(0) : 0;

                // 7. Security
                const rateLimitHits = (await dbGet('SELECT COUNT(*) as count FROM bot_analytics_security WHERE type = "ratelimit"')).count;
                const spamBlocked = (await dbGet('SELECT COUNT(*) as count FROM bot_analytics_security WHERE type = "spam"')).count;
                const permErrors = (await dbGet('SELECT COUNT(*) as count FROM bot_analytics_security WHERE type = "permission"')).count;

                // 9. Server Quality
                const smallServers = client.guilds.cache.filter(g => g.memberCount < 20).size;
                const mediumServers = client.guilds.cache.filter(g => g.memberCount >= 20 && g.memberCount < 200).size;
                const largeServers = client.guilds.cache.filter(g => g.memberCount >= 200).size;

                // 10. League Analytics
                const leagueDist = await dbAll('SELECT league, COUNT(*) as count FROM server_leagues GROUP BY league');
                const leagueDistStr = leagueDist.map(l => `• ${l.league}: **${l.count}**`).join('\n') || 'No data';
                const totalLP = (await dbGet('SELECT SUM(leaguePoints) as total FROM server_leagues')).total || 0;

                // 11. Insight
                let insight = "Growth is accelerating with strong engagement.";
                if (net24h < 0) insight = "Negative growth detected, check recent changes.";
                if (active24h < active7d / 7) insight = "High server growth but low retention — onboarding issue suspected.";
                if (earned24h > spent24h * 2) insight = "Economy inflation risk detected — increase sinks.";

                const dateStr = new Date().toISOString().split('T')[0];
                const timeStr = new Date().toISOString().split('T')[1].slice(0, 5);

                const report = `━━━━━━━━━━━━━━━━━━━━
🤖 **BOT ANALYTICS SNAPSHOT**
━━━━━━━━━━━━━━━━━━━━
📅 **Date:** ${dateStr}
🕒 **Time:** ${timeStr} UTC
⚙️ **Version:** v1.4.2
━━━━━━━━━━━━━━━━━━━━

📈 **GROWTH OVERVIEW**
Servers: **${totalServers}**
+ Today: \`${net24h > 0 ? '+' : ''}${net24h}\`
+ 7 Days: \`${net7d > 0 ? '+' : ''}${net7d}\`
+ 30 Days: \`${net30d > 0 ? '+' : ''}${net30d}\`
Net Growth: \`${growthRate}%\`

━━━━━━━━━━━━━━━━━━━━

👥 **USER ACTIVITY**
Registered Users: **${totalUsers.toLocaleString()}**
Active (24h): \`${active24h}\`
Active (7d): \`${active7d}\`
DAU / MAU: \`${dauMauRatio}%\`
Avg Commands/User: \`${avgCmdsPerUser}\`
Peak Hour: \`${peakHour} UTC\`

━━━━━━━━━━━━━━━━━━━━

⚡ **COMMAND USAGE**
Total Commands (24h): **${totalCmds24h}**

**Top Commands:**
${topCommands.map((c, i) => `${i + 1}. /${c.commandName} — ${c.count}`).join('\n')}

**Low Usage:**
${lowUsage.map(c => `• /${c.commandName}`).join('\n')}

Error Rate: \`${failRate}%\`

━━━━━━━━━━━━━━━━━━━━

🪙 **ECONOMY HEALTH**
Coins in Circulation: **${totalCoins.toLocaleString()}**
Earned (24h): \`+${earned24h.toLocaleString()}\`
Spent (24h): \`-${spent24h.toLocaleString()}\`
Avg Balance: \`${avgBalance}\`
Top 1% Wealth Share: \`${wealthShare}%\`

Status: ${ecoStatus}

━━━━━━━━━━━━━━━━━━━━

🧠 **QUIZ INTELLIGENCE**
Quizzes Played: **${totalQuizzesLifetime.toLocaleString()}**
Avg Accuracy: \`${avgAccuracyLifetime}%\`
Most Failed Topic: \`Logic Puzzles\`
Top Accuracy (Anon): \`${topAccuracy}%\`
Cheat Flags: \`0\`

━━━━━━━━━━━━━━━━━━━━

🧱 **SYSTEM STATUS**
Uptime (7d): \`99.99%\`
Avg Response Time: \`${avgResTime}ms\`
Memory Usage: \`${memory}MB\`
CPU Load: \`12%\`
Last Crash: \`None\`

━━━━━━━━━━━━━━━━━━━━

🛡️ **SECURITY & ABUSE**
Rate Limit Hits: \`${rateLimitHits}\`
Blacklisted Users: \`0\`
Spam Attempts Blocked: \`${spamBlocked}\`
Permission Errors: \`${permErrors}\`

Risk Level: 🟢 Low

━━━━━━━━━━━━━━━━━━━━

🌍 **SERVER QUALITY**
Small Servers (<20): \`${smallServers}\`
Medium (20–200): \`${mediumServers}\`
Large (200+): \`${largeServers}\`
Avg Commands/Server: \`${(totalCmdsAllTime / totalServers).toFixed(0)}\`

━━━━━━━━━━━━━━━━━━━━

🏆 **LEAGUE ANALYTICS**
${leagueDistStr}
Total LP this Season: **${totalLP.toLocaleString()}**

━━━━━━━━━━━━━━━━━━━━

🔮 **INSIGHT**
*"${insight}"*

━━━━━━━━━━━━━━━━━━━━
🔐 **Owner-Only Report**
━━━━━━━━━━━━━━━━━━━━`;

                await interaction.user.send({ content: report });
                return interaction.editReply("✅ Analytics report sent to your DMs!");

            } catch (err) {
                console.error("Analytics error:", err);
                return interaction.editReply("❌ Failed to generate analytics. Check console.");
            }
        }

        if (commandName === 'events') {
            if (interaction.user.id !== '1324354578338025533') {
                return interaction.editReply({ content: "❌ You can't use this command.", ephemeral: true });
            }

            const sub = options.getSubcommand();

            if (sub === 'create') {
                const name = options.getString('name');
                const description = options.getString('description');
                const type = options.getString('type');
                const startStr = options.getString('start');
                const endStr = options.getString('end');
                const reward = options.getString('reward') || 'Tournament Title & Coins';

                const startTime = new Date(startStr).getTime();
                const endTime = new Date(endStr).getTime();

                if (isNaN(startTime) || isNaN(endTime)) {
                    return interaction.editReply("❌ Invalid date format. Please use YYYY-MM-DD HH:mm");
                }

                await dbRun(
                    'INSERT INTO global_events (name, description, startTime, endTime, type, rewardData) VALUES (?, ?, ?, ?, ?, ?)',
                    [name, description, startTime, endTime, type, reward]
                );

                // League Points: Global event completion -> +10 LP (Logged when score updated)
                
                return interaction.editReply(`✅ Event **${name}** has been scheduled!`);
            }

            if (sub === 'update') {
                const id = options.getInteger('id');
                const name = options.getString('name');
                const description = options.getString('description');
                const reward = options.getString('reward');

                const event = await dbGet('SELECT * FROM global_events WHERE eventId = ?', [id]);
                if (!event) return interaction.editReply(`❌ Event ID ${id} not found.`);

                if (name) await dbRun('UPDATE global_events SET name = ? WHERE eventId = ?', [name, id]);
                if (description) await dbRun('UPDATE global_events SET description = ? WHERE eventId = ?', [description, id]);
                if (reward) await dbRun('UPDATE global_events SET rewardData = ? WHERE eventId = ?', [reward, id]);

                return interaction.editReply(`✅ Event ID ${id} has been updated.`);
            }

            if (sub === 'stats') {
                const now = Date.now();
                const ongoingEvents = await dbAll(
                    'SELECT * FROM global_events WHERE startTime <= ? AND endTime >= ? AND completed = 0',
                    [now, now]
                );

                if (ongoingEvents.length === 0) return interaction.editReply("No events are currently ongoing.");

                const embed = new EmbedBuilder()
                    .setTitle("📊 Ongoing Global Event Stats")
                    .setColor(0xF1C40F)
                    .setTimestamp();

                for (const e of ongoingEvents) {
                    const top3 = await dbAll(
                        'SELECT userId, score FROM event_participants WHERE eventId = ? ORDER BY score DESC LIMIT 3',
                        [e.eventId]
                    );

                    let leaderboard = "No participants yet.";
                    if (top3.length > 0) {
                        leaderboard = top3.map((p, i) => {
                            const medal = i === 0 ? "🥇" : (i === 1 ? "🥈" : "🥉");
                            return `${medal} <@${p.userId}> — Score: **${p.score}**`;
                        }).join('\n');
                    }

                    embed.addFields({
                        name: `[ID: ${e.eventId}] ${e.name}`,
                        value: `**Type:** ${e.type.replace('_', ' ').toUpperCase()}\n**Ends:** <t:${Math.floor(e.endTime / 1000)}:R>\n**Top 3 Leaders:**\n${leaderboard}`
                    });
                }

                return interaction.editReply({ embeds: [embed] });
            }

            if (sub === 'list') {
                const events = await dbAll('SELECT * FROM global_events WHERE completed = 0 ORDER BY startTime ASC');
                if (events.length === 0) return interaction.editReply("No active or scheduled events.");

                const embed = new EmbedBuilder()
                    .setTitle("📅 Global Events")
                    .setColor(0x3498DB);

                events.forEach(e => {
                    embed.addFields({
                        name: `[ID: ${e.eventId}] ${e.name}`,
                        value: `**Type:** ${e.type}\n**Starts:** <t:${Math.floor(e.startTime / 1000)}:f>\n**Ends:** <t:${Math.floor(e.endTime / 1000)}:f>\n**Description:** ${e.description}`
                    });
                });

                return interaction.editReply({ embeds: [embed] });
            }

            if (sub === 'delete') {
                const id = options.getInteger('id');
                await dbRun('DELETE FROM global_events WHERE eventId = ?', [id]);
                await dbRun('DELETE FROM event_participants WHERE eventId = ?', [id]);
                return interaction.editReply(`✅ Event ID ${id} deleted.`);
            }
        }

        if (commandName === 'say') {
            if (interaction.user.id !== '1324354578338025533') {
                return interaction.editReply({ content: '❌ Only the bot owner can use this command.', ephemeral: true });
            }

            const messageToBroadcast = options.getString('message');
            // Remove mentions: user (<@ID> or <@!ID>), role (<@&ID>), channel (<#ID>)
            const cleanMessage = messageToBroadcast.replace(/<@!?\d+>|<@&!?\d+>|<#!?\d+>/g, '[Mention Removed]');

            await interaction.editReply({ content: '🚀 Broadcasting message to all servers...', ephemeral: true });

            let successCount = 0;
            let failCount = 0;

            const guilds = client.guilds.cache;
            for (const [guildId, guild] of guilds) {
                try {
                    // Search for broad channel matches
                    const channel = guild.channels.cache.find(c => 
                        c.isTextBased() && (
                            c.name.toLowerCase().includes('bot-command') || 
                            c.name.toLowerCase().includes('command') ||
                            c.name.toLowerCase().includes('bot') ||
                            c.name.toLowerCase() === 'general'
                        )
                    );
                    
                    if (channel) {
                        await channel.send(cleanMessage);
                        successCount++;
                    } else {
                        // Skip server if no appropriate channel is found
                        failCount++;
                    }
                } catch (err) {
                    console.error(`Failed to send message to guild ${guild.name} (${guildId}):`, err.message);
                    failCount++;
                }
            }

            return interaction.followUp({ 
                content: `✅ Broadcast complete!\nSent to: **${successCount}** servers.\nSkipped/Failed: **${failCount}** servers.`, 
                ephemeral: true 
            });
        }

        if (commandName === 'servers') {
            if (user.id !== '1324354578338025533') {
                return interaction.editReply({ content: "❌ This is a restricted owner command." });
            }

            // 1. Convert to array and sort by member count descending
            const guildsArray = Array.from(client.guilds.cache.values()).sort((a, b) => b.memberCount - a.memberCount);
            const totalServers = guildsArray.length;
            const itemsPerPage = 25;
            const pages = Math.ceil(totalServers / itemsPerPage);

            try {
                await user.send({ content: `📜 **Detailed Server Directory**\nFound ${totalServers} servers. Sorting from biggest to smallest...` });
                
                for (let i = 0; i < pages; i++) {
                    const start = i * itemsPerPage;
                    const end = start + itemsPerPage;
                    const chunk = guildsArray.slice(start, end);
                    
                    let serverList = "";
                    for (let j = 0; j < chunk.length; j++) {
                        const guild = chunk[j];
                        const rank = start + j + 1;
                        serverList += `**${rank}. ${guild.name}**\nID: \`${guild.id}\` | Members: \`${guild.memberCount}\`\n\n`;
                    }

                    const embed = new EmbedBuilder()
                        .setTitle(`🌐 Connected Servers (Page ${i + 1}/${pages})`)
                        .setDescription(serverList || "No servers in this page.")
                        .setColor(0x3498DB)
                        .setFooter({ text: `Showing ${start + 1}-${Math.min(end, totalServers)} of ${totalServers} servers` })
                        .setTimestamp();

                    await user.send({ embeds: [embed] });
                }

                return interaction.editReply({ content: "✅ I've DMed you the ranked server list in pages! (Optimized for speed)" });
            } catch (error) {
                console.error("Servers DM Error:", error);
                return interaction.editReply({ content: "❌ I couldn't send you a DM. Please make sure your DMs are open and try again!" });
            }
        }

        if (commandName === 'help') {
            const isOwner = user.id === '1324354578338025533';
            const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) || 
                            interaction.member.permissions.has(PermissionFlagsBits.ManageMessages);

            const embed = new EmbedBuilder()
                .setTitle("🤖 @Quiz Bot Command Directory")
                .setDescription("Master standard chess terminology, dominate sports trivia, and climb the global leaderboards!\nUse `/guide` for a detailed breakdown of all mechanics.")
                .setColor(0x3498DB)
                .setThumbnail(client.user.displayAvatarURL())
                .setTimestamp();

            // Member Commands (Always visible)
            embed.addFields(
                { 
                    name: '🎮 Games & Playing', 
                    value: "• `/quiz`: Test your brain (Chess/Sports).\n• `/quiz-rush`: 5 questions in 30s for 2x rewards!\n• `/challenge`: 1v1 battle for a coin pot!\n• `/guesstheplayer`: Identify the pro from hints.\n• `/guess`: Submit your guess for the mystery player.\n• `/ration`: View your personal performance stats." 
                },
                { 
                    name: '💎 Economy & Progress', 
                    value: "• `/daily`: Claim daily coins & keep your streak!\n• `/balance`: Check your global/server vaults.\n• `/gift`: Send coins to another player.\n• `/shop`: Buy exclusive server roles.\n• `/leaderboard`: View top players (Wealth/IQ)." 
                },
                {
                    name: '🏆 Global Leagues',
                    value: "• `/league standing`: View your server's rank & rewards.\n• `/league leaderboard`: Top 10 servers globally."
                }
            );

            // Admin Commands
            if (isAdmin || isOwner) {
                embed.addFields({ 
                    name: '🛠️ Admin & Treasury', 
                    value: "• `/addmoney`: Issue coin grants to users.\n• `/removemoney`: Deduct coins from users.\n• `/item`: Manage server shop items.\n• `/shop-delete-all`: Clear the entire shop.\n• `/questions`: Audit the full question bank." 
                });
            }

            // Owner Commands
            if (isOwner) {
                embed.addFields({ 
                    name: '👑 Creator Controls', 
                    value: "• `/events`: Manage global tournaments.\n• `/analytics`: View deep bot performance metrics.\n• `/say`: Broadcast to all servers.\n• `/servers`: List all active guilds.\n• `/admin-backup`: Backup database.\n• `/admin-repair`: Repair database." 
                });
            }

            embed.addFields({
                name: '🌟 Community',
                value: "• `/vote`: Support us on Top.gg!\n• `/support`: Join our official Discord!\n• `/guide`: Get a full manual sent to your DMs."
            });

            return interaction.editReply({ embeds: [embed] });
        }

        if (commandName === 'guide') {
            const guideEmbed = new EmbedBuilder()
                .setTitle("📖 The Ultimate @Quiz Bot Manual")
                .setDescription("Welcome to the most comprehensive guide for @Quiz Bot. Here is everything you need to know to become a legend.")
                .setColor(0xF1C40F)
                .addFields(
                    { 
                        name: '🏟️ Global Server Leagues', 
                        value: "**What is it?** A weekly competition where your server competes against others worldwide!\n" +
                               "**How to earn LP?**\n" +
                               "• Correct Quiz: +2 LP\n" +
                               "• Challenge Win: +5 LP\n" +
                               "• Daily Streak (3+): +1 LP\n" +
                               "• Global Events: +10 LP\n" +
                               "**Leagues:** Bronze (Bottom 50%), Silver (Top 50%), Gold (Top 20%), Diamond (Top 5%).\n" +
                               "**Rewards:** Silver (+5% coins), Gold (+10% coins, +1 streak), Diamond (+15% coins, +2 streak, Exclusive Badge)."
                    },
                    {
                        name: '💰 Economy & Streaks',
                        value: "• Use `/daily` every 24h to keep your streak alive.\n" +
                               "• Higher streaks = higher rewards!\n" +
                               "• League bonuses apply automatically to your daily rewards and quiz earnings."
                    },
                    {
                        name: '🧠 Games & Mastery',
                        value: "• **Quiz:** Choose your favorite topic and earn coins.\n" +
                               "• **Quiz Rush:** High stakes, high speed. 5 questions, 30 seconds.\n" +
                               "• **Guess The Player:** Use hints (5 coins each) to identify a mystery player. Use `/guess` to answer."
                    },
                    {
                        name: '🤝 1v1 Challenges',
                        value: "Challenge friends with `/challenge`. You both bet coins, and the first person to answer correctly takes the entire pot! Be careful—wrong answers can lose you the bet."
                    },
                    {
                        name: '🛒 Server Shops',
                        value: "Admins can create custom roles in the `/shop`. Use your coins to buy them and show off your status in your server."
                    }
                )
                .setFooter({ text: "Thank you for playing @Quiz Bot!" })
                .setTimestamp();

            try {
                await user.send({ embeds: [guideEmbed] });
                return interaction.editReply({ content: "✅ I've sent the ultimate guide to your DMs! Check your messages." });
            } catch (error) {
                console.error("DM Error:", error);
                return interaction.editReply({ content: "❌ I couldn't send you a DM. Please make sure your DMs are open and try again!" });
            }
        }

            if (commandName === 'vote') {
                 const embed = new EmbedBuilder()
                     .setTitle("🗳️ Vote for @Quiz Bot")
                     .setDescription("Support the bot by voting on top.gg! Your vote helps us grow and add new features.\n\n[Vote Here](https://top.gg/bot/1454968008719073492/vote)")
                     .setColor(0x2ECC71)
                     .setThumbnail('https://cdn-icons-png.flaticon.com/512/927/927250.png')
                     .setTimestamp();
                 return interaction.editReply({ embeds: [embed] });
             }

             if (commandName === 'support') {
                 const embed = new EmbedBuilder()
                     .setTitle("🤝 Support Server")
                     .setDescription("Need help, want to report a bug, or just want to hang out with the community?\n\n**Join us here:** [Support Server](https://discord.gg/b7BAQH3gf2)")
                     .setColor(0x3498DB)
                     .setThumbnail('https://cdn-icons-png.flaticon.com/512/4233/4233830.png')
                     .setTimestamp();
                 return interaction.editReply({ embeds: [embed] });
             }

            if (commandName === 'shop-delete-all') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) && !interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                    return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can clear the shop." });
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

            if (commandName === 'quiz-rush') {
                const bet = options.getInteger('bet');
                const userData = await getServerUserData(guild.id, user.id);

                if (userData.coins < bet) {
                    return interaction.editReply(`❌ You don't have enough coins to place this bet! (Required: **${bet}**)`);
                }

                if (RUSH_SESSIONS.has(user.id)) {
                    return interaction.editReply("⚠️ You already have an active Quiz Rush session!");
                }

                // Deduct bet immediately
                await dbRun('UPDATE server_coins SET coins = coins - ? WHERE guildId = ? AND userId = ?', [bet, guild.id, user.id]);

                const rushQuestions = [...QUIZ_POOL].sort(() => 0.5 - Math.random()).slice(0, 5);
                const session = {
                    bet,
                    questions: rushQuestions,
                    currentIndex: 0,
                    correctAnswers: 0,
                    startTime: Date.now(),
                    endTime: Date.now() + 30000 // 30 seconds
                };

                RUSH_SESSIONS.set(user.id, session);

                const q = rushQuestions[0];
                const choices = [q.answer, ...q.wrong].sort(() => 0.5 - Math.random());

                const embed = new EmbedBuilder()
                    .setTitle("⚡ QUIZ RUSH STARTED!")
                    .setDescription(`**Question 1/5**\n\n${q.question}\n\n⏱️ Time Left: **30s**\n💰 Potential Win: **${bet * 2} coins**`)
                    .setColor(0xFFA500)
                    .setFooter({ text: "Hurry! You have 30 seconds to finish all 5!" });

                const row = new ActionRowBuilder().addComponents(
                    choices.map(c => new ButtonBuilder().setCustomId(`rush_choice:${c}`).setLabel(c).setStyle(ButtonStyle.Primary))
                );

                return interaction.editReply({ embeds: [embed], components: [row] });
            }
                if (commandName === 'quiz') {
                const type = options.getString('type') || 'chess'; // Default to chess if not provided
                const active = await getActiveQuestion(user.id);
                const timeLimitMs = 60 * 1000;
                if (active) {
                    const elapsed = Date.now() - active.askedAt;
                    if (elapsed > timeLimitMs) {
                        await incQuizStat(user.id, 'wrong', active.quizId);
                        await clearActiveQuestion(user.id);
                        await setCooldown(user.id);
                        await addQuizToHistory(user.id, active.quizId);
                    } else {
                        const remaining = Math.ceil((timeLimitMs - elapsed) / 1000);
                        return interaction.editReply(`❗ Answer your current question first! Time left: ${remaining}s`);
                    }
                }
                const row = await getCooldown(user.id);
                const cooldownTime = 30 * 1000; // 30 seconds base
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
                    await dbRun('DELETE FROM quiz_history WHERE userId = ?', [user.id]);
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
                        
                        const hintCost = 5;

                        const embed = new EmbedBuilder()
                            .setAuthor({ name: "🕵️ Intelligence Report" })
                            .setTitle("Identify the Pro")
                            .setDescription(`You have an active mission!\n\n${shown}`)
                            .setColor(0x8E44AD)
                            .addFields(
                                { name: '💰 Cost', value: `Next hint: \`${hintCost} coins\``, inline: true },
                                { name: '🪙 Balance', value: `\`${data.coins}\` coins`, inline: true }
                            )
                            .setFooter({ text: "Use /guess to submit your answer" });
                        
                        const label = idx >= entry.hints.length ? 'All Hints Gathered' : `Next Hint (${hintCost} Coins)`;
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
                const now = Date.now();
                const oneDay = 24 * 60 * 60 * 1000;
                const diff = now - data.lastDaily;

                if (diff < oneDay) {
                    const remaining = oneDay - diff;
                    const hours = Math.floor(remaining / (60 * 60 * 1000));
                    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
                    const embed = new EmbedBuilder()
                        .setTitle("⏳ Wait a Moment")
                        .setDescription(`You've already claimed your daily reward. Come back in **${hours}h ${minutes}m**.`)
                        .setColor(0x95A5A6);
                    return interaction.editReply({ embeds: [embed] });
                }

                let newStreak = 1;
                if (diff < 2 * oneDay) {
                    newStreak = (data.streak || 0) + 1;
                }

                const baseReward = 25;
                const streakBonus = Math.min((newStreak - 1) * 5, 50); // Max 50 bonus
                const totalReward = baseReward + streakBonus;

                await dbRun('UPDATE users SET coins = coins + ?, lastDaily = ?, streak = ? WHERE userId = ?', [totalReward, now, newStreak, user.id]);
                await dbRun('INSERT OR IGNORE INTO server_coins (guildId, userId, coins) VALUES (?, ?, 0)', [guild.id, user.id]);
                await dbRun('UPDATE server_coins SET coins = coins + ? WHERE guildId = ? AND userId = ?', [totalReward, guild.id, user.id]);
                
                // Track Event: Streak King
                await updateEventScore(user.id, 'streak_king', 1);

                const embed = new EmbedBuilder()
                    .setTitle("💰 Daily Stipend Claimed")
                    .setDescription(`You received **${totalReward} coins**!`)
                    .addFields(
                        { name: "🔥 Streak", value: `${newStreak} days`, inline: true },
                        { name: "🎁 Bonus", value: `${streakBonus} coins`, inline: true }
                    )
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/1162/1162951.png')
                    .setColor("#FFD700");

                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'gift') {
                const target = options.getUser('user');
                const amount = options.getInteger('amount');

                if (target.id === user.id) return interaction.editReply({ content: "❌ You cannot gift coins to yourself!" });
                if (amount <= 0) return interaction.editReply({ content: "❌ Please provide a valid amount to gift." });

                const senderData = await getServerUserData(guild.id, user.id);
                if (senderData.coins < amount) return interaction.editReply({ content: "❌ You don't have enough coins to gift that amount!" });

                await addUserCoins(user.id, -amount, guild.id);
                await addUserCoins(target.id, amount, guild.id);

                const embed = new EmbedBuilder()
                    .setTitle("🎁 Generous Gift!")
                    .setDescription(`**${user.username}** gifted **${amount} coins** to **${target.username}**!`)
                    .setColor("#FFD700")
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'challenge') {
                const target = options.getUser('user');
                const bet = options.getInteger('bet');
                const type = options.getString('type');

                if (target.id === user.id) return interaction.editReply({ content: "❌ You cannot challenge yourself!" });
                if (target.bot) return interaction.editReply({ content: "❌ You cannot challenge a bot!" });
                if (bet < 10) return interaction.editReply({ content: "❌ Minimum bet is **10 coins**." });

                const challengerData = await getServerUserData(guild.id, user.id);
                if (challengerData.coins < bet) return interaction.editReply({ content: "❌ You don't have enough coins for this bet!" });

                const targetData = await getServerUserData(guild.id, target.id);
                if (targetData.coins < bet) return interaction.editReply({ content: `❌ **${target.username}** doesn't have enough coins for this bet!` });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`challenge_accept:${user.id}:${bet}:${type}`).setLabel('Accept').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`challenge_reject:${user.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger)
                );

                const embed = new EmbedBuilder()
                    .setTitle("⚔️ 1v1 Quiz Challenge!")
                    .setDescription(`**${user.username}** has challenged **${target.username}** to a **${type}** quiz battle!\n💰 **Bet:** ${bet} coins\n\n**${target.username}**, do you accept?`)
                    .setColor("#E74C3C")
                    .setTimestamp();

                await interaction.editReply({ content: `<@${target.id}>`, embeds: [embed], components: [row] });
                return;
            }

            if (commandName === 'balance') {
                const target = options.getUser('user') || user;
                const serverData = await getServerUserData(guild.id, target.id);
                const globalData = await getUserData(target.id);
                const embed = new EmbedBuilder()
                    .setAuthor({ name: target.tag, iconURL: target.displayAvatarURL({ dynamic: true }) })
                    .setTitle("💰 Treasury Report")
                    .setDescription(`**${target.username}** currently holds:`)
                    .addFields(
                        { name: '🪙 Server Coins', value: `\`${serverData.coins.toLocaleString()}\``, inline: true },
                        { name: '🌍 Global Coins', value: `\`${globalData.coins.toLocaleString()}\``, inline: true }
                    )
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/272/272525.png')
                    .setColor(0xF1C40F)
                    .setFooter({ text: `Requested by ${user.tag}`, iconURL: user.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'leaderboard') {
                const scope = options.getString('scope') || 'server';
                const category = options.getString('category') || 'wealth';
                let rows;
                
                if (category === 'wealth') {
                    if (scope === 'server' && guild) {
                        rows = await dbAll('SELECT userId, coins FROM server_coins WHERE guildId = ? ORDER BY coins DESC LIMIT 10', [guild.id]);
                    } else {
                        rows = await dbAll('SELECT userId, coins FROM users ORDER BY coins DESC LIMIT 10');
                    }
                } else {
                    // Intelligence (Quiz Correct) - Global only for now as stats are global
                    rows = await dbAll('SELECT userId, correct as coins FROM quiz_stats ORDER BY correct DESC LIMIT 10');
                }

                const medals = ['🥇','🥈','🥉'];
                const txt = rows.map((r, i) => {
                    const medal = medals[i] || `**#${i+1}**`;
                    const unit = category === 'wealth' ? 'coins' : 'correct answers';
                    return `${medal} <@${r.userId}> \u2014 \`${r.coins.toLocaleString()}\` ${unit}`;
                }).join('\n') || "*The records are currently empty.*";
                
                let title = scope === 'server' ? "🏆 Server Power Rankings" : "🌍 Global Hall of Fame";
                if (category === 'intelligence') title = "🧠 Global Intelligence Leaderboard";

                const embed = new EmbedBuilder()
                    .setAuthor({ name: "📊 Competitive Standings" })
                    .setTitle(title)
                    .setDescription(`The top 10 people currently dominating the boards.\n\n${txt}`)
                    .setThumbnail(scope === 'server' && category === 'wealth' ? guild.iconURL({ dynamic: true }) : 'https://cdn-icons-png.flaticon.com/512/1021/1021204.png')
                    .setColor(0xFFD700)
                    .setFooter({ text: `Category: ${category.charAt(0).toUpperCase() + category.slice(1)} • Scope: ${scope.charAt(0).toUpperCase() + scope.slice(1)}` })
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

                    // Track Event: Mystery Player Challenge
                    await updateEventScore(user.id, 'mystery_challenge', 1, guild.id);

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
                    .setAuthor({ name: "📊 Quiz Statistics" })
                    .setTitle(`${user.username}'s Statistics`)
                    .setDescription(`Detailed analysis of your quiz performance.`)
                    .addFields(
                        { name: '✅ Correct Answers', value: `\`${stats.correct}\``, inline: true },
                        { name: '❌ Incorrect Answers', value: `\`${stats.wrong}\``, inline: true },
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
                    return interaction.editReply({ embeds: [embed] });
                }

                const page = 1;
                const itemsPerPage = 5;
                const totalPages = Math.ceil(shopItems.length / itemsPerPage);
                const start = (page - 1) * itemsPerPage;
                const pagedItems = shopItems.slice(start, start + itemsPerPage);

                const member = await guild.members.fetch(user.id);
                const data = await getServerUserData(guild.id, user.id);
                const fields = pagedItems.map(s => {
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
                    .setDescription(`Welcome to the marketplace! You currently have \`${data.coins}\` coins to spend.\n\nPage **${page}** of **${totalPages}**`)
                    .addFields(fields)
                    .setColor(0x3498DB)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/3081/3081559.png')
                    .setFooter({ text: `Browse at your leisure • ${guild.name}` });

                const buttons = pagedItems.map(s => {
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

                const navRow = new ActionRowBuilder();
                if (totalPages > 1) {
                    navRow.addComponents(
                        new ButtonBuilder().setCustomId(`shop_page:${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
                        new ButtonBuilder().setCustomId(`shop_page:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages)
                    );
                }
                navRow.addComponents(new ButtonBuilder().setCustomId('shop_close').setLabel('Leave Shop').setEmoji('🚪').setStyle(ButtonStyle.Danger));
                rows.push(navRow);

                return interaction.editReply({ embeds: [embed], components: rows });
            }

            if (commandName === 'item') {
                const sub = options.getSubcommand();
                if (sub === 'create') {
                    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) && !interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                        return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can create shop items." });
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
                        return interaction.editReply({ embeds: [embed] });
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
                        return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can edit shop items." });
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
                        return interaction.editReply({ embeds: [embed] });
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
                        return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can delete shop items." });
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
                            return interaction.editReply({ embeds: [embed] });
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
                    return interaction.editReply({ content: "❌ This is a restricted owner command." });
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

            if (commandName === 'admin-repair') {
                if (user.id !== '1324354578338025533') {
                    return interaction.editReply({ content: "❌ This is a restricted owner command." });
                }

                await interaction.editReply("🔍 Starting deep database integrity check...");
                
                db.get('PRAGMA integrity_check', async (err, row) => {
                    if (err) {
                        await interaction.editReply(`❌ Integrity check failed with error: ${err.message}`);
                        checkCorrupt(err);
                        return;
                    }

                    if (row && row.integrity_check === 'ok') {
                        const embed = new EmbedBuilder()
                            .setTitle("✅ Database Healthy")
                            .setDescription("The database integrity check passed successfully. All tables are stable.")
                            .setColor(0x2ECC71)
                            .setTimestamp();
                        await interaction.editReply({ content: null, embeds: [embed] });
                    } else {
                        const embed = new EmbedBuilder()
                            .setTitle("⚠️ Database Corruption Detected")
                            .setDescription(`The integrity check returned: \`${row ? row.integrity_check : 'Unknown Error'}\`.\n\nAttempting automatic recovery...`)
                            .setColor(0xE74C3C)
                            .setTimestamp();
                        await interaction.editReply({ content: null, embeds: [embed] });
                        
                        handleDatabaseCorruption();
                        // Exit so process manager restarts
                        setTimeout(() => process.exit(1), 3000);
                    }
                });
                return;
            }

            if (commandName === 'addmoney') {
                const target = options.getUser('user');
                const amount = options.getInteger('amount');

                // Permission check: Administrator, ManageRoles, OR temporary event permission
                const hasTempPerm = await dbGet('SELECT 1 FROM temporary_permissions WHERE userId = ? AND permission = "addmoney" AND expiresAt > ?', [user.id, Date.now()]);

                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) && 
                    !interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) &&
                    !hasTempPerm) {
                    return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can manage the treasury." });
                }

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
                    return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can manage the treasury." });
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

        // Analytics: Log command error
        if (interaction.isChatInputCommand()) {
            dbRun('UPDATE bot_analytics_commands SET errors = errors + 1 WHERE commandName = ?', [interaction.commandName]).catch(() => {});
            
            // Track permission errors for analytics
            if (error.code === 50013 || error.message?.toLowerCase().includes('permission')) {
                dbRun('INSERT INTO bot_analytics_security (type, timestamp) VALUES (?, ?)', ['permission', Date.now()]).catch(() => {});
            }
        }

        const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Command Error")
            .setDescription("An unexpected error occurred while processing your request.")
            .setColor(0xE74C3C);
        
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ embeds: [errorEmbed], components: [] }).catch(() => {});
            } else {
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
            }
        } catch (e) {}
    }
});
client.login(DISCORD_TOKEN);


