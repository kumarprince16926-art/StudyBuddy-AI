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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);

const jwtSecret = process.env.JWT_SECRET;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing.");
if (!jwtSecret) throw new Error("JWT_SECRET is missing.");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

pool.on("error", err => console.error("Database error:", err));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.static(publicDir));

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "StudyBuddy AI" });
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    "User-agent: *\nAllow: /\nSitemap: https://studybuddy-ai-1-mktp.onrender.com/sitemap.xml"
  );
});

app.get("/sitemap.xml", (req, res) => {
  res.sendFile(path.join(publicDir, "sitemap.xml"));
});

/*
 * The current website sends the image as FormData field "image".
 * Older website/bot integrations may send "photo".
 * Accept both names so Multer does not return "Unexpected field".
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Only JPG, PNG and WEBP images are allowed."));
  }
});

function receiveQuestionImage(req, res, next) {
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "photo", maxCount: 1 }
  ])(req, res, err => {
    if (err) return next(err);
    req.questionImage =
      req.files?.image?.[0] ||
      req.files?.photo?.[0] ||
      null;
    next();
  });
}

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
let cloudflareAI;

function ai() {
  if (!process.env.CLOUDFLARE_ACCOUNT_ID ||
      !process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error("Cloudflare configuration is missing.");
  }

  if (!cloudflareAI) {
    cloudflareAI = new OpenAI({
      apiKey: process.env.CLOUDFLARE_API_TOKEN,
      baseURL:
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`
    });
  }

  return cloudflareAI;
}

const TUTOR_PROMPT = `
You are StudyBuddy AI, a friendly and accurate tutor for students in classes 6 to 12 and college.
Follow the student's selected language. If no language is selected, use simple Hindi.
Adapt the depth to the student's selected level.
Explain concepts step by step using clear headings, short paragraphs and bullet points.
When useful, give one real-life example and one practice question.
For maths and science, show the reasoning and calculations clearly.
Never invent facts, sources, marks, or exam claims.
If an uploaded image or question is unclear, say what is unclear and ask for a clearer image.
Be encouraging, respectful, age-appropriate, and focused on learning.
`;

async function askAI(system, question, maxTokens = 1500) {
  const result = await ai().chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: question }
    ],
    max_tokens: maxTokens,
    temperature: 0.3
  });

  return result.choices?.[0]?.message?.content || "Please try again.";
}

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || "")
      .replace(/^Bearer\s+/i, "");

    if (!token) {
      return res.status(401).json({ error: "Please sign in first." });
    }

    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please sign in again." });
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chats (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      subject TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notes (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      subject TEXT,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      score INTEGER NOT NULL,
      total INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("Database initialized.");
}

// REGISTER
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name?.trim() || !email?.trim() ||
        !password || password.length < 8) {
      return res.status(400).json({
        error: "Enter name, email and password of at least 8 characters."
      });
    }

    const cleanEmail = email.trim().toLowerCase();
    const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const role = cleanEmail === adminEmail && adminEmail
      ? "admin" : "student";

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users(name,email,password_hash,role)
       VALUES($1,$2,$3,$4)
       RETURNING id,name,email,role,plan`,
      [name.trim(), cleanEmail, hash, role]
    );

    const user = result.rows[0];
    res.json({
      token: jwt.sign(user, jwtSecret, { expiresIn: "7d" }),
      user
    });
  } catch (err) {
    console.error("REGISTER:", err);
    res.status(err.code === "23505" ? 409 : 500).json({
      error: err.code === "23505"
        ? "Email already registered. Please sign in."
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
      id: String(row.id),
      name: row.name,
      email: row.email,
      role: row.role,
      plan: row.plan
    };

    res.json({
      token: jwt.sign(user, jwtSecret, { expiresIn: "7d" }),
      user
    });
  } catch (err) {
    console.error("LOGIN:", err);
    res.status(500).json({ error: "Login failed." });
  }
});

// PROFILE
app.get("/api/me", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id,name,email,role,plan FROM users WHERE id=$1",
      [req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("PROFILE:", err);
    res.status(500).json({ error: "Could not load profile." });
  }
});

// SOLVE DOUBT + PHOTO (accepts both image and photo field names)
app.post("/api/solve", auth, receiveQuestionImage, async (req, res) => {
  try {
    const question = String(req.body.question || "").trim();
    const subject = String(req.body.subject || "General");
    const level = String(req.body.level || "School");
    const language = String(req.body.language || "Hindi");
    const imageFile = req.questionImage;

    if (!question && !imageFile) {
      return res.status(400).json({
        error: "Enter a question or upload a photo."
      });
    }

    const prompt = `
Subject: ${subject}
Student level: ${level}
Preferred language: ${language}
Question: ${question || "Read and solve the attached image."}
Explain step by step at the selected learning level.
`;

    let answer;

    if (imageFile) {
      const imageData =
        `data:${imageFile.mimetype};base64,${imageFile.buffer.toString("base64")}`;

      const result = await ai().chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: TUTOR_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageData } }
            ]
          }
        ],
        max_tokens: 1800,
        temperature: 0.3
      });

      answer = result.choices?.[0]?.message?.content;
    } else {
      answer = await askAI(TUTOR_PROMPT, prompt, 1800);
    }

    if (!answer) throw new Error("Empty AI response.");

    await pool.query(
      `INSERT INTO chats(user_id,question,answer,subject)
       VALUES($1,$2,$3,$4)`,
      [req.user.id, question || "Photo question", answer, subject]
    );

    res.json({ answer });
  } catch (err) {
    console.error("SOLVE ERROR:", err);
    res.status(500).json({
      error: "Could not solve this question. Please try again."
    });
  }
});

// CHAT HISTORY
app.get("/api/history", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,question,answer,subject,created_at
       FROM chats WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({ history: result.rows });
  } catch (err) {
    console.error("HISTORY:", err);
    res.status(500).json({ error: "Could not load history." });
  }
});

// DELETE ONE CHAT (used by the current website)
app.delete("/api/history/:id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM chats WHERE id=$1 AND user_id=$2 RETURNING id",
      [req.params.id, req.user.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "History item not found." });
    }
    res.json({ message: "History item deleted." });
  } catch (err) {
    console.error("DELETE HISTORY ITEM:", err);
    res.status(500).json({ error: "Could not delete history item." });
  }
});

// DELETE ALL CHAT HISTORY
app.delete("/api/history", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM chats WHERE user_id=$1", [req.user.id]);
    res.json({ message: "Chat history deleted." });
  } catch (err) {
    console.error("DELETE HISTORY:", err);
    res.status(500).json({ error: "Could not delete history." });
  }
});

// CREATE NOTES
app.post("/api/notes", auth, async (req, res) => {
  try {
    const topic = String(req.body.topic || "").trim();
    const subject = String(req.body.subject || "General");
    if (!topic) return res.status(400).json({ error: "Enter a topic." });

    const content = await askAI(
      TUTOR_PROMPT,
      `Create detailed study notes on ${topic}. Subject: ${subject}. Use the selected language if provided.`,
      1800
    );

    const result = await pool.query(
      `INSERT INTO notes(user_id,topic,subject,content)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [req.user.id, topic, subject, content]
    );
    res.json({ note: result.rows[0] });
  } catch (err) {
    console.error("CREATE NOTE:", err);
    res.status(500).json({ error: "Could not create notes." });
  }
});

// GET NOTES
app.get("/api/notes", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notes WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ notes: result.rows });
  } catch (err) {
    console.error("GET NOTES:", err);
    res.status(500).json({ error: "Could not load notes." });
  }
});

// DELETE NOTE
app.delete("/api/notes/:id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM notes WHERE id=$1 AND user_id=$2 RETURNING id",
      [req.params.id, req.user.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "Note not found." });
    }
    res.json({ message: "Note deleted." });
  } catch (err) {
    console.error("DELETE NOTE:", err);
    res.status(500).json({ error: "Could not delete note." });
  }
});

// PRACTICE QUESTIONS
app.post("/api/practice", auth, async (req, res) => {
  try {
    const topic = String(req.body.topic || "").trim();
    if (!topic) return res.status(400).json({ error: "Enter a topic." });

    const questions = await askAI(
      TUTOR_PROMPT,
      `Create 5 practice questions about ${topic}. Put the answers in a separate answer section.`,
      1500
    );
    res.json({ questions });
  } catch (err) {
    console.error("PRACTICE:", err);
    res.status(500).json({ error: "Could not create practice questions." });
  }
});

// GENERATE QUIZ
app.post("/api/quiz", auth, async (req, res) => {
  try {
    const topic = String(req.body.topic || "").trim();
    if (!topic) return res.status(400).json({ error: "Enter a topic." });

    const quiz = await askAI(
      TUTOR_PROMPT,
      `Create a 5-question multiple-choice quiz about ${topic}.
       Give four options A, B, C, D. Put the answer key after all questions.`,
      1600
    );
    res.json({ quiz });
  } catch (err) {
    console.error("QUIZ:", err);
    res.status(500).json({ error: "Could not create quiz." });
  }
});

// SAVE QUIZ SCORE
app.post("/api/quiz/score", auth, async (req, res) => {
  try {
    const topic = String(req.body.topic || "General");
    const score = Number(req.body.score);
    const total = Number(req.body.total);

    if (!Number.isInteger(score) || !Number.isInteger(total) ||
        total < 1 || score < 0 || score > total) {
      return res.status(400).json({ error: "Invalid quiz score." });
    }

    await pool.query(
      `INSERT INTO quiz_attempts(user_id,topic,score,total)
       VALUES($1,$2,$3,$4)`,
      [req.user.id, topic, score, total]
    );
    res.json({ message: "Score saved." });
  } catch (err) {
    console.error("SAVE QUIZ SCORE:", err);
    res.status(500).json({ error: "Could not save score." });
  }
});

// QUIZ HISTORY
app.get("/api/quiz/history", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT topic,score,total,created_at
       FROM quiz_attempts WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ attempts: result.rows });
  } catch (err) {
    console.error("QUIZ HISTORY:", err);
    res.status(500).json({ error: "Could not load quiz history." });
  }
});

// ADMIN SUMMARY (older endpoint retained)
app.get("/api/admin", auth, admin, async (req, res) => {
  try {
    const [users, chats, notes] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users"),
      pool.query("SELECT COUNT(*) FROM chats"),
      pool.query("SELECT COUNT(*) FROM notes")
    ]);
    res.json({
      users: Number(users.rows[0].count),
      doubtsSolved: Number(chats.rows[0].count),
      notesCreated: Number(notes.rows[0].count)
    });
  } catch (err) {
    console.error("ADMIN SUMMARY:", err);
    res.status(500).json({ error: "Could not load admin dashboard." });
  }
});

// ADMIN OVERVIEW (endpoint used by redesigned website)
app.get("/api/admin/overview", auth, admin, async (req, res) => {
  try {
    const [usersCount, doubtsCount, users] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users"),
      pool.query("SELECT COUNT(*) FROM chats"),
      pool.query(
        `SELECT id,name,email,role,plan
         FROM users ORDER BY created_at DESC LIMIT 100`
      )
    ]);

    res.json({
      totalUsers: Number(usersCount.rows[0].count),
      totalDoubts: Number(doubtsCount.rows[0].count),
      users: users.rows
    });
  } catch (err) {
    console.error("ADMIN OVERVIEW:", err);
    res.status(500).json({ error: "Could not load admin overview." });
  }
});

// ADMIN: UPDATE USER PLAN
app.patch("/api/admin/users/:id/plan", auth, admin, async (req, res) => {
  try {
    const plan = String(req.body?.plan || "").toLowerCase();
    if (!["free", "premium"].includes(plan)) {
      return res.status(400).json({ error: "Plan must be free or premium." });
    }

    const result = await pool.query(
      "UPDATE users SET plan=$1 WHERE id=$2 RETURNING id,name,email,role,plan",
      [plan, req.params.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "User not found." });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("ADMIN UPDATE PLAN:", err);
    res.status(500).json({ error: "Could not update user plan." });
  }
});

/* =====================================
   TELEGRAM BOT - TEXT + PHOTO SUPPORT
===================================== */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function telegram(method, body = {}) {
  if (!telegramToken) throw new Error("Telegram bot token missing.");

  const response = await fetch(
    `https://api.telegram.org/bot${telegramToken}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40000)
    }
  );

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram API error (${response.status})`);
  }
  return data.result;
}

async function getTelegramImage(fileId) {
  const file = await telegram("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Photo not found.");
  if (file.file_size && file.file_size > 8 * 1024 * 1024) {
    throw new Error("Photo must be under 8 MB.");
  }

  const response = await fetch(
    `https://api.telegram.org/file/bot${telegramToken}/${file.file_path}`,
    { signal: AbortSignal.timeout(30000) }
  );
  if (!response.ok) throw new Error("Photo download failed.");

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 8 * 1024 * 1024) {
    throw new Error("Photo must be under 8 MB.");
  }

  const extension = file.file_path.split(".").pop().toLowerCase();
  const mimeTypes = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp"
  };
  const mime = mimeTypes[extension];
  if (!mime) throw new Error("Only JPG, PNG and WEBP photos are supported.");

  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function telegramAnswer(chatId, question, imageData = null) {
  const content = imageData
    ? [
        {
          type: "text",
          text: question || "Read and solve this photo step by step in simple Hindi."
        },
        { type: "image_url", image_url: { url: imageData } }
      ]
    : question;

  const result = await ai().chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: TUTOR_PROMPT },
      { role: "user", content }
    ],
    max_tokens: 1800,
    temperature: 0.3
  });

  const answer = result.choices?.[0]?.message?.content || "Please try again.";
  const chunks = answer.match(/[\s\S]{1,4000}/g) || ["Please try again."];

  for (const chunk of chunks) {
    await telegram("sendMessage", { chat_id: chatId, text: chunk });
  }
}

let telegramRunning = false;
    console.error("Telegram bot could not start:", err.message);
  }
}

// JSON error response for Multer and other request errors
app.use((err, req, res, next) => {
  console.error("REQUEST ERROR:", err);
  if (res.headersSent) return next(err);

  const isUploadError =
    err instanceof multer.MulterError ||
    /image|photo|file|multipart|field/i.test(err.message || "");

  res.status(err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE" ? 413 : 400)
    .json({
      error: isUploadError
        ? (err.code === "LIMIT_FILE_SIZE"
            ? "Image must be under 8 MB."
            : err.message || "Image upload failed.")
        : "Invalid request."
    });
});

// Start only after database is ready
initializeDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`StudyBuddy AI running on port ${PORT}`);
      if (telegramToken) startTelegramBot();
      else console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN is not set.");
    });
  })
  .catch(err => {
    console.error("Startup failed:", err);
    process.exit(1);
  });
