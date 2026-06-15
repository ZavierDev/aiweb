/**
 * Fullstack Real-time AI Chat (ChatGPT-like)
 * Express + Socket.io + MySQL + bcrypt + express-session
 */
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");
const { Server } = require("socket.io");
const config = require("./config");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* ------------------------------------------------------------------ */
/* DATABASE BOOTSTRAP                                                  */
/* ------------------------------------------------------------------ */
let pool;
async function initDb() {
  // Ensure database exists
  const root = await mysql.createConnection({
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true
  });
  await root.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4`
  );
  await root.end();

  pool = mysql.createPool({
    ...config.db,
    waitForConnections: true,
    connectionLimit: 10
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(191) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      title VARCHAR(255) DEFAULT 'New Chat',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      conversation_id INT NOT NULL,
      role ENUM('user','assistant') NOT NULL,
      content LONGTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  console.log("✅ Database ready");
}

/* ------------------------------------------------------------------ */
/* MIDDLEWARE                                                          */
/* ------------------------------------------------------------------ */
const sessionMiddleware = session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
});

app.use(express.json({ limit: "2mb" }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));

// share session with socket.io
io.engine.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "unauthorized" });
  next();
}

/* ------------------------------------------------------------------ */
/* AUTH ROUTES                                                         */
/* ------------------------------------------------------------------ */
app.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 4)
      return res.status(400).json({ error: "Email & password (min 4) wajib" });
    const hash = await bcrypt.hash(password, 10);
    const [r] = await pool.query("INSERT INTO users (email, password) VALUES (?, ?)", [
      email.toLowerCase().trim(),
      hash
    ]);
    req.session.userId = r.insertId;
    req.session.email = email;
    res.json({ ok: true, email });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY")
      return res.status(400).json({ error: "Email sudah terdaftar" });
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Wajib isi" });
    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [
      email.toLowerCase().trim()
    ]);
    if (!rows.length) return res.status(401).json({ error: "Akun tidak ditemukan" });
    const ok = await bcrypt.compare(password, rows[0].password);
    if (!ok) return res.status(401).json({ error: "Password salah" });
    req.session.userId = rows[0].id;
    req.session.email = rows[0].email;
    res.json({ ok: true, email: rows[0].email });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/me", (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "unauthorized" });
  res.json({ id: req.session.userId, email: req.session.email });
});

/* ------------------------------------------------------------------ */
/* CHAT REST (initial load)                                            */
/* ------------------------------------------------------------------ */
app.get("/conversations", requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, title, created_at FROM conversations WHERE user_id=? ORDER BY id DESC",
    [req.session.userId]
  );
  res.json(rows);
});

app.get("/conversations/:id/messages", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const [own] = await pool.query(
    "SELECT id FROM conversations WHERE id=? AND user_id=?",
    [id, req.session.userId]
  );
  if (!own.length) return res.status(404).json({ error: "not found" });
  const [rows] = await pool.query(
    "SELECT role, content, created_at FROM messages WHERE conversation_id=? ORDER BY id ASC",
    [id]
  );
  res.json(rows);
});

app.delete("/conversations/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM conversations WHERE id=? AND user_id=?", [
    Number(req.params.id),
    req.session.userId
  ]);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* AI CALL                                                             */
/* ------------------------------------------------------------------ */
async function callAI(message) {
  const r = await fetch(config.ai.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.ai.apiKey
    },
    body: JSON.stringify({ message })
  });
  const text = await r.text();
  // Try to parse JSON; if not, return raw text
  try {
    const j = JSON.parse(text);
    // common shapes: {result}, {data}, {response}, {message}
    return (
      j.result || j.data || j.response || j.message || j.answer || j.text || text
    );
  } catch {
    return text;
  }
}

/* ------------------------------------------------------------------ */
/* SOCKET.IO                                                           */
/* ------------------------------------------------------------------ */
function getUserId(socket) {
  return socket.request.session && socket.request.session.userId;
}

io.use((socket, next) => {
  if (!getUserId(socket)) return next(new Error("unauthorized"));
  next();
});

io.on("connection", (socket) => {
  const userId = getUserId(socket);

  const sendConversationList = async () => {
    const [rows] = await pool.query(
      "SELECT id, title, created_at FROM conversations WHERE user_id=? ORDER BY id DESC",
      [userId]
    );
    socket.emit("conversation_list", rows);
  };

  sendConversationList();

  socket.on("create_conversation", async () => {
    const [r] = await pool.query(
      "INSERT INTO conversations (user_id, title) VALUES (?, 'New Chat')",
      [userId]
    );
    await sendConversationList();
    socket.emit("conversation_created", { id: r.insertId });
  });

  socket.on("load_conversation", async (id) => {
    const cid = Number(id);
    const [own] = await pool.query(
      "SELECT id, title FROM conversations WHERE id=? AND user_id=?",
      [cid, userId]
    );
    if (!own.length) return;
    const [rows] = await pool.query(
      "SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id ASC",
      [cid]
    );
    socket.emit("conversation_loaded", { id: cid, title: own[0].title, messages: rows });
  });

  socket.on("typing", (isTyping) => {
    socket.emit("ai_typing", !!isTyping);
  });

  socket.on("send_message", async (payload) => {
    try {
      const text = String(payload?.text || "").trim();
      let conversationId = Number(payload?.conversationId) || null;
      if (!text) return;

      // Create conversation if needed
      if (!conversationId) {
        const title = text.length > 40 ? text.slice(0, 40) + "…" : text;
        const [r] = await pool.query(
          "INSERT INTO conversations (user_id, title) VALUES (?, ?)",
          [userId, title]
        );
        conversationId = r.insertId;
        await sendConversationList();
        socket.emit("conversation_created", { id: conversationId, title });
      } else {
        // verify ownership
        const [own] = await pool.query(
          "SELECT id, title FROM conversations WHERE id=? AND user_id=?",
          [conversationId, userId]
        );
        if (!own.length) return;
        // If still default title -> rename from first user message
        if (own[0].title === "New Chat") {
          const title = text.length > 40 ? text.slice(0, 40) + "…" : text;
          await pool.query("UPDATE conversations SET title=? WHERE id=?", [
            title,
            conversationId
          ]);
          await sendConversationList();
        }
      }

      // Save user message
      await pool.query(
        "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)",
        [conversationId, text]
      );
      socket.emit("user_message_saved", { conversationId });

      // typing indicator
      socket.emit("ai_typing", true);

      // Call AI
      let aiText;
      try {
        aiText = await callAI(text);
      } catch (e) {
        aiText = "⚠️ Maaf, terjadi kesalahan menghubungi AI: " + e.message;
      }
      aiText = String(aiText || "");

      // Stream response word-by-word
      const chunks = aiText.split(/(\s+)/); // keep whitespace
      let acc = "";
      for (const c of chunks) {
        acc += c;
        socket.emit("message_stream", { conversationId, delta: c });
        // delay 20-40ms
        await new Promise((res) => setTimeout(res, 20 + Math.random() * 20));
      }

      // Save assistant message
      await pool.query(
        "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', ?)",
        [conversationId, aiText]
      );

      socket.emit("ai_typing", false);
      socket.emit("message_done", { conversationId, content: aiText });
    } catch (e) {
      console.error(e);
      socket.emit("ai_typing", false);
      socket.emit("message_done", {
        conversationId: payload?.conversationId,
        content: "⚠️ Server error"
      });
    }
  });
});

/* ------------------------------------------------------------------ */
/* BOOT                                                                */
/* ------------------------------------------------------------------ */
initDb()
  .then(() => {
    server.listen(config.port, () => {
      console.log(`🚀 http://localhost:${config.port}`);
    });
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });
