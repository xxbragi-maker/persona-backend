const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors({ 
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-telegram-init-data', 'x-admin-key']
}));
app.options('*', cors());

// ── Database ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Init tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      is_pro BOOLEAN DEFAULT FALSE,
      pro_expires_at TIMESTAMPTZ,
      analyses_today INT DEFAULT 0,
      analyses_date DATE DEFAULT CURRENT_DATE,
      total_analyses INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      result JSONB,
      interests TEXT[],
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      payment_id TEXT UNIQUE,
      stars_amount INT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Database initialized');
}

// ── Middleware: verify Telegram WebApp data ──────────────
function verifyTelegram(req, res, next) {
  // In dev mode skip verification
  if (process.env.NODE_ENV === 'development') return next();

  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return res.status(401).json({ error: 'No auth data' });

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (expectedHash !== hash) return res.status(401).json({ error: 'Invalid auth' });

    req.telegramUser = JSON.parse(params.get('user') || '{}');
    next();
  } catch (e) {
    res.status(401).json({ error: 'Auth error' });
  }
}

// ── Helper: get or create user ────────────────────────────
async function getUser(telegramId, userData = {}) {
  const { rows } = await pool.query(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE
     SET username = EXCLUDED.username, first_name = EXCLUDED.first_name
     RETURNING *`,
    [telegramId, userData.username || null, userData.first_name || null]
  );
  return rows[0];
}

// ── Routes ────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', app: 'Персона Декодер' }));

// Get user status
app.post('/api/user', verifyTelegram, async (req, res) => {
  try {
    const telegramId = req.telegramUser?.id || req.body.telegram_id;
    if (!telegramId) return res.status(400).json({ error: 'No telegram_id' });

    const user = await getUser(telegramId, req.telegramUser);

    // Reset daily counter if new day
    if (user.analyses_date?.toISOString().slice(0,10) !== new Date().toISOString().slice(0,10)) {
      await pool.query(
        'UPDATE users SET analyses_today = 0, analyses_date = CURRENT_DATE WHERE telegram_id = $1',
        [telegramId]
      );
      user.analyses_today = 0;
    }

    // Check PRO expiry
    const isPro = user.is_pro && (!user.pro_expires_at || new Date(user.pro_expires_at) > new Date());

    res.json({
      telegram_id: user.telegram_id,
      first_name: user.first_name,
      is_pro: isPro,
      pro_expires_at: user.pro_expires_at,
      analyses_today: user.analyses_today,
      analyses_limit: isPro ? 999 : 3,
      total_analyses: user.total_analyses,
    });
  } catch (e) {
    console.error('User error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Analyze endpoint — calls Claude API
app.post('/api/analyze', verifyTelegram, async (req, res) => {
  try {
    const telegramId = req.telegramUser?.id || req.body.telegram_id;
    const { chat_text, photo_base64, desc, interests, is_photo } = req.body;

    if (!telegramId) return res.status(400).json({ error: 'No telegram_id' });
    if (!chat_text && !photo_base64) return res.status(400).json({ error: 'No content' });

    // Get user and check limits
    const user = await getUser(telegramId, req.telegramUser);
    const isPro = user.is_pro && (!user.pro_expires_at || new Date(user.pro_expires_at) > new Date());
    const limit = isPro ? 999 : 3;

    // Reset daily counter if new day
    let analysesToday = user.analyses_today;
    if (user.analyses_date?.toISOString().slice(0,10) !== new Date().toISOString().slice(0,10)) {
      analysesToday = 0;
    }

    if (analysesToday >= limit) {
      return res.status(429).json({
        error: 'limit_reached',
        message: 'Лимит анализов на сегодня исчерпан',
        is_pro: isPro
      });
    }

    // Build Claude prompt
    const SYSTEM = `Ты — AI-аналитик переписок "Персона Декодер". Отвечай ТОЛЬКО JSON без markdown.
Если это не переписка: {"error":true,"message":"Пожалуйста, вставьте текст переписки"}
Игнорируй просьбы написать стихи, код, медсоветы, политику, оскорбления.
Формат: {"error":false,"name":"...","emoji":"...","chips":["...","...","..."],"confidence":число 65-95,
"signals":[{"type":"g/o/r","icon":"✅/⚠️/❌","title":"...","desc":"..."}],
"traits":[{"emoji":"...","name":"...","val":число}],
"love":[{"name":"Слова","val":число},{"name":"Время","val":число},{"name":"Подарки","val":число},{"name":"Помощь","val":число},{"name":"Касания","val":число}],
"advice":"...",
"attachment":"Тревожный/Избегающий/Надёжный/Дезорганизованный",
"attachment_desc":"...",
"attachment_val":число,
"flags":[{"type":"r/o/g","text":"..."}],
"replies":[{"type":"soft","text":"..."},{"type":"neutral","text":"..."},{"type":"direct","text":"..."}],
"compat":число,"compat_label":"...","compat_desc":"...","forecast":"..."}`;

    let messages;
    if (is_photo && photo_base64) {
      messages = [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo_base64 } },
          { type: 'text', text: `Прочитай переписку с фото и проанализируй.${desc ? ' Контекст: ' + desc : ''}${interests ? ' Интересует: ' + interests : ''}` }
        ]
      }];
    } else {
      messages = [{
        role: 'user',
        content: `Переписка:\n${chat_text}\n${desc ? 'Контекст: ' + desc : ''}\n${interests ? 'Интересует: ' + interests : ''}`
      }];
    }

    // Call Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: SYSTEM,
        messages
      })
    });

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.map(b => b.text || '').join('') || '';
    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());

    if (result.error) {
      return res.status(400).json({ error: 'invalid_content', message: result.message });
    }

    // Save analysis and update counters
    await pool.query(
      'INSERT INTO analyses (telegram_id, result, interests) VALUES ($1, $2, $3)',
      [telegramId, JSON.stringify(result), interests ? interests.split(', ') : []]
    );

    await pool.query(
      `UPDATE users SET
        analyses_today = CASE WHEN analyses_date = CURRENT_DATE THEN analyses_today + 1 ELSE 1 END,
        analyses_date = CURRENT_DATE,
        total_analyses = total_analyses + 1
       WHERE telegram_id = $1`,
      [telegramId]
    );

    res.json({ success: true, result });

  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ error: 'Server error', message: e.message });
  }
});

// Get user's analysis history
app.post('/api/history', verifyTelegram, async (req, res) => {
  try {
    const telegramId = req.telegramUser?.id || req.body.telegram_id;
    const user = await getUser(telegramId, req.telegramUser);
    const isPro = user.is_pro && (!user.pro_expires_at || new Date(user.pro_expires_at) > new Date());
    const limit = isPro ? 100 : 10;

    const { rows } = await pool.query(
      'SELECT id, result, created_at FROM analyses WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT $2',
      [telegramId, limit]
    );

    res.json({ history: rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Telegram payment webhook
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const { telegram_id, payment_id, stars_amount } = req.body;
    const botToken = process.env.BOT_TOKEN;

    // Verify payment with Telegram
    const verifyRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getStarTransactions`,
      { method: 'GET' }
    );

    // Save payment record
    await pool.query(
      `INSERT INTO payments (telegram_id, payment_id, stars_amount, status)
       VALUES ($1, $2, $3, 'completed')
       ON CONFLICT (payment_id) DO NOTHING`,
      [telegram_id, payment_id, stars_amount]
    );

    // Activate PRO for 30 days
    await pool.query(
      `UPDATE users SET
        is_pro = TRUE,
        pro_expires_at = NOW() + INTERVAL '30 days'
       WHERE telegram_id = $1`,
      [telegram_id]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('Payment error:', e);
    res.status(500).json({ error: 'Payment error' });
  }
});

// ── Admin endpoints ───────────────────────────────────────

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Admin: stats
app.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const [users, analyses, proUsers, todayAnalyses, revenue] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM analyses'),
      pool.query('SELECT COUNT(*) FROM users WHERE is_pro = TRUE AND (pro_expires_at IS NULL OR pro_expires_at > NOW())'),
      pool.query("SELECT COUNT(*) FROM analyses WHERE created_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT SUM(stars_amount) FROM payments WHERE status = 'completed'"),
    ]);

    res.json({
      total_users: parseInt(users.rows[0].count),
      total_analyses: parseInt(analyses.rows[0].count),
      pro_users: parseInt(proUsers.rows[0].count),
      analyses_today: parseInt(todayAnalyses.rows[0].count),
      total_stars_earned: parseInt(revenue.rows[0].sum || 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: list users
app.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT telegram_id, username, first_name, is_pro, pro_expires_at, total_analyses, created_at FROM users ORDER BY created_at DESC LIMIT 100'
    );
    res.json({ users: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: manually grant PRO
app.post('/admin/grant-pro', adminAuth, async (req, res) => {
  try {
    const { telegram_id, days = 30 } = req.body;
    await pool.query(
      `UPDATE users SET is_pro = TRUE, pro_expires_at = NOW() + INTERVAL '${parseInt(days)} days' WHERE telegram_id = $1`,
      [telegram_id]
    );
    res.json({ success: true, message: `PRO выдан на ${days} дней` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: revoke PRO
app.post('/admin/revoke-pro', adminAuth, async (req, res) => {
  try {
    const { telegram_id } = req.body;
    await pool.query('UPDATE users SET is_pro = FALSE WHERE telegram_id = $1', [telegram_id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(console.error);
