import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing.");
if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is missing.");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on("error", err => console.error("PostgreSQL pool error:", err));

const jwtSecret = process.env.JWT_SECRET;
app.use(express.json({ limit: "1mb" }));

app.get("/robots.txt", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("text/plain").send(
    "User-agent: *\nAllow: /\nSitemap: https://studybuddy-ai-1-mktp.onrender.com/sitemap.xml\n"
  );
});

app.get("/sitemap.xml", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("application/xml").sendFile(path.join(publicDir, "sitemap.xml"));
});

app.use(express.static(publicDir));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(
      allowed.includes(file.mimetype) ? null : new Error("Use JPG, PNG or WEBP."),
      allowed.includes(file.mimetype)
    );
  }
});

let cloudflareAI;

function ai() {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("Cloudflare configuration is missing.");
  }

  if (!cloudflareAI) {
    cloudflareAI = new OpenAI({
      apiKey: process.env.CLOUDFLARE_API_TOKEN,
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`
    });
  }

  return cloudflareAI;
}

const MODEL = "@cf/google/gemma-4-26b-a4b-it";

async function askAI(system, user, maxTokens = 1400) {
  const result = await ai().chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    max_tokens: maxTokens,
    temperature: 0.3
  });

  const content = result.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "Please try again.";
}

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

    if (!token) {
      return res.status(401).json({ error: "Please sign in first." });
    }

    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch {
    return res.status(401).json({
      error: "Session expired. Please sign in again."
    });
  }
}

function admin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access only." });
  }

  next();
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      plan TEXT NOT NULL DEFAULT 'free',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chats (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      subject TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS chats_user_id_idx ON chats(user_id);

    CREATE TABLE IF NOT EXISTS notes (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      topic TEXT NOT NULL,
      subject TEXT,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS notes_user_id_idx ON notes(user_id);

    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      topic TEXT NOT NULL,
      score INTEGER NOT NULL,
      total INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS quiz_user_id_idx ON quiz_attempts(user_id);
  `);

  console.log("PostgreSQL database connected successfully.");
}

// REGISTER
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name?.trim() || !email?.trim() || !password || password.length < 8) {
      return res.status(400).json({
        error: "Enter your name, email and password of at least 8 characters."
      });
    }

    const clean = email.trim().toLowerCase();
    const role =
      clean === process.env.ADMIN_EMAIL?.trim().toLowerCase()
        ? "admin"
        : "student";

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users(name,email,password_hash,role)
       VALUES($1,$2,$3,$4)
       RETURNING id,name,email,role,plan`,
      [name.trim(), clean, hash, role]
    );

    const user = result.rows[0];

    res.json({
      token: jwt.sign(user, jwtSecret, { expiresIn: "7d" }),
      user
    });
  } catch (e) {
    console.error("REGISTER ERROR:", e);

    res.status(e.code === "23505" ? 409 : 500).json({
      error:
        e.code === "23505"
          ? "That email is already registered. Please sign in."
          : "Could not create account."
    });
  }
});

// LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    const row = result.rows[0];

    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({
        error: "Email or password is incorrect."
      });
    }

    const user = {
      id: Number(row.id),
      name: row.name,
      email: row.email,
      role: row.role,
      plan: row.plan
    };

    res.json({
      token: jwt.sign(user, jwtSecret, { expiresIn: "7d" }),
      user
    });
  } catch (e) {
    console.error("LOGIN ERROR:", e);
    res.status(500).json({ error: "Login failed." });
  }
});

// CURRENT USER
app.get("/api/me", auth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id,name,email,role,plan,created_at FROM users WHERE id=$1",
      [req.user.id]
    );

    if (!r.rows[0]) {
      return res.status(404).json({ error: "Account not found." });
    }

    r.rows[0].id = Number(r.rows[0].id);
    res.json({ user: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load account." });
  }
});

// CHAT HISTORY
app.get("/api/history", auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,question,answer,subject,created_at
       FROM chats WHERE user_id=$1
       ORDER BY id DESC LIMIT 50`,
      [req.user.id]
    );

    res.json({ history: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load history." });
  }
});

app.delete("/api/history/:id", auth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM chats WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not delete history." });
  }
});

// AI DOUBT SOLVER + PHOTO
app.post("/api/solve", auth, upload.single("image"), async (req, res) => {
  const started = Date.now();

  try {
    const {
      question = "",
      subject = "General",
      language = "English",
      level = "School"
    } = req.body || {};

    if (!String(question).trim() && !req.file) {
      return res.status(400).json({
        error: "Type a question or upload a photo."
      });
    }

    const content = [{
      type: "text",
      text: `Subject: ${subject}. Student level: ${level}. Reply in ${language}. Question: ${question || "Read and solve the attached question."}`
    }];

    if (req.file) {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`
        }
      });
    }

    const response = await ai().chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: `You are StudyBuddy AI, a friendly and accurate tutor for school students. Explain in simple ${language}, suitable for ${level}. Use short headings and steps, one real-life example where useful, and end with one practice question. Be concise, factual and patient. Never request personal or secret information.`
        },
        { role: "user", content }
      ],
      max_tokens: 1400,
      temperature: 0.3
    });

    const answer =
      response.choices?.[0]?.message?.content || "Please try again.";

    await pool.query(
      `INSERT INTO chats(user_id,question,answer,subject)
       VALUES($1,$2,$3,$4)`,
      [req.user.id, question || "[Photo question]", answer, subject]
    );

    console.log("Solve request completed in", Date.now() - started, "ms");
    res.json({ answer });
  } catch (e) {
    console.error("SOLVE ERROR:", e);

    res.status(500).json({
      error: e.message?.includes("Cloudflare configuration")
        ? e.message
        : "Could not solve this right now. Check Cloudflare settings and try again."
    });
  }
});

// CREATE NOTES
app.post("/api/notes", auth, async (req, res) => {
  try {
    const {
      topic = "",
      subject = "General",
      level = "School",
      language = "English"
    } = req.body || {};

    if (!topic.trim()) {
      return res.status(400).json({ error: "Enter a topic for your notes." });
    }

    const content = await askAI(
      `You are a school notes writer. Create clear, accurate revision notes for ${level} students in ${language}. Use a title, short headings, key points, definitions and a quick recap. Do not invent facts.`,
      `Subject: ${subject}\nTopic: ${topic}`,
      1800
    );

    const saved = await pool.query(
      `INSERT INTO notes(user_id,topic,subject,content)
       VALUES($1,$2,$3,$4)
       RETURNING id,topic,subject,content,created_at`,
      [req.user.id, topic.trim(), subject, content]
    );

    res.json({ note: saved.rows[0] });
  } catch (e) {
    console.error("NOTES ERROR:", e);

    res.status(500).json({
      error: e.message?.includes("Cloudflare configuration")
        ? e.message
        : "Could not create notes right now."
    });
  }
});

app.get("/api/notes", auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,topic,subject,content,created_at
       FROM notes WHERE user_id=$1
       ORDER BY id DESC LIMIT 30`,
      [req.user.id]
    );

    res.json({ notes: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load notes." });
  }
});

// GENERATE QUIZ
app.post("/api/quiz", auth, async (req, res) => {
  try {
    const {
      topic = "",
      subject = "General",
      level = "School",
      language = "English"
    } = req.body || {};

    if (!topic.trim()) {
      return res.status(400).json({ error: "Enter a topic for your quiz." });
    }

    const raw = await askAI(
      `Create exactly 5 multiple-choice questions for ${level} students in ${language}. Return ONLY valid JSON, no markdown, in this shape: {"questions":[{"question":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."}]}. correct must be a zero-based integer. Ensure exactly four options and one correct answer per question.`,
      `Subject: ${subject}. Topic: ${topic}`,
      1800
    );

    const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start < 0 || end < start) {
      throw new Error("Quiz format error. Please generate it again.");
    }

    const parsed = JSON.parse(cleaned.slice(start, end + 1));

    if (!Array.isArray(parsed.questions) || parsed.questions.length < 1) {
      throw new Error("Quiz format error. Please try again.");
    }

    const questions = parsed.questions.slice(0, 5).map(q => ({
      question: String(q.question || ""),
      options: Array.isArray(q.options) ? q.options.slice(0, 4).map(String) : [],
      correct: Number(q.correct),
      explanation: String(q.explanation || "")
    })).filter(q =>
      q.question &&
      q.options.length === 4 &&
      Number.isInteger(q.correct) &&
      q.correct >= 0 &&
      q.correct < 4
    );

    if (!questions.length) {
      throw new Error("Quiz format error. Please try again.");
    }

    res.json({ topic, questions });
  } catch (e) {
    console.error("QUIZ ERROR:", e);

    res.status(500).json({
      error: e.message?.includes("Cloudflare configuration")
        ? e.message
        : "Could not create a quiz. Please try again."
    });
  }
});

// SAVE QUIZ RESULT
app.post("/api/quiz/submit", auth, async (req, res) => {
  try {
    const { topic = "Practice quiz", score, total } = req.body || {};
    const s = Number(score);
    const t = Number(total);

    if (
      !Number.isInteger(s) ||
      !Number.isInteger(t) ||
      t < 1 ||
      s < 0 ||
      s > t ||
      t > 50
    ) {
      return res.status(400).json({ error: "Invalid quiz score." });
    }

    await pool.query(
      `INSERT INTO quiz_attempts(user_id,topic,score,total)
       VALUES($1,$2,$3,$4)`,
      [req.user.id, String(topic).slice(0, 160), s, t]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not save quiz result." });
  }
});

// STUDENT PROGRESS
app.get("/api/progress", auth, async (req, res) => {
  try {
    const [chats, notes, quizzes, recent] = await Promise.all([
      pool.query(
        "SELECT COUNT(*)::int AS count FROM chats WHERE user_id=$1",
        [req.user.id]
      ),
      pool.query(
        "SELECT COUNT(*)::int AS count FROM notes WHERE user_id=$1",
        [req.user.id]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count,
         COALESCE(SUM(score),0)::int AS score,
         COALESCE(SUM(total),0)::int AS total
         FROM quiz_attempts WHERE user_id=$1`,
        [req.user.id]
      ),
      pool.query(
        `SELECT id,topic,score,total,created_at
         FROM quiz_attempts WHERE user_id=$1
         ORDER BY id DESC LIMIT 5`,
        [req.user.id]
      )
    ]);

    res.json({
      doubtsSolved: chats.rows[0].count,
      notesCreated: notes.rows[0].count,
      quizzesTaken: quizzes.rows[0].count,
      quizScore: quizzes.rows[0].score,
      quizTotal: quizzes.rows[0].total,
      recentQuizzes: recent.rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load progress." });
  }
});

// ADMIN DASHBOARD
app.get("/api/admin/overview", auth, admin, async (req, res) => {
  try {
    const [users, totals, doubts, notes, quizzes] = await Promise.all([
      pool.query(
        `SELECT id,name,email,role,plan,created_at
         FROM users ORDER BY id DESC LIMIT 200`
      ),
      pool.query("SELECT COUNT(*)::int AS users FROM users"),
      pool.query("SELECT COUNT(*)::int AS doubts FROM chats"),
      pool.query("SELECT COUNT(*)::int AS notes FROM notes"),
      pool.query("SELECT COUNT(*)::int AS quizzes FROM quiz_attempts")
    ]);

    res.json({
      users: users.rows,
      totalUsers: totals.rows[0].users,
      totalDoubts: doubts.rows[0].doubts,
      totalNotes: notes.rows[0].notes,
      totalQuizzes: quizzes.rows[0].quizzes
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load admin overview." });
  }
});

app.patch("/api/admin/users/:id/plan", auth, admin, async (req, res) => {
  try {
    const plan = ["free", "premium"].includes(req.body?.plan)
      ? req.body.plan
      : null;

    if (!plan) {
      return res.status(400).json({ error: "Plan must be free or premium." });
    }

    const r = await pool.query(
      "UPDATE users SET plan=$1 WHERE id=$2",
      [plan, req.params.id]
    );

    if (!r.rowCount) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not update user plan." });
  }
});

// JSON API ERROR HANDLING
app.use("/api", (err, req, res, next) => {
  console.error("API ERROR:", err);

  if (res.headersSent) return next(err);

  res.status(err.status || 400).json({
    error: err.message || "Request failed."
  });
});

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);

  if (res.headersSent) return next(err);

  res.status(err.status || 500).json({
    error: "Server error. Please try again."
  });
});

const PORT = process.env.PORT || 3000;

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`StudyBuddy running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("DATABASE STARTUP ERROR:", err);
    process.exit(1);
  });
