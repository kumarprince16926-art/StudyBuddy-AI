 
import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";

const app = express();
const db = new Database("studybuddy.db");

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student',
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  subject TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const jwtSecret = process.env.JWT_SECRET;

const ai = () => new OpenAI({
  apiKey: process.env.CLOUDFLARE_API_TOKEN,
  baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`
});

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

    if (!token || !jwtSecret) {
      return res.status(401).json({ error: "Please sign in first." });
    }

    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}

function admin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access only." });
  }
  next();
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
    const role = clean === process.env.ADMIN_EMAIL?.trim().toLowerCase()
      ? "admin"
      : "student";

    const hash = await bcrypt.hash(password, 12);

    const result = db.prepare(
      "INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)"
    ).run(name.trim(), clean, hash, role);

    const user = {
      id: Number(result.lastInsertRowid),
      name: name.trim(),
      email: clean,
      role,
      plan: "free"
    };

    const token = jwt.sign(user, jwtSecret, { expiresIn: "7d" });

    res.json({ token, user });
  } catch (e) {
    res.status(409).json({
      error: e.code === "SQLITE_CONSTRAINT_UNIQUE"
        ? "That email is already registered."
        : "Could not create account."
    });
  }
});

// LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    const row = db.prepare(
      "SELECT * FROM users WHERE email=?"
    ).get(email);

    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    const user = {
      id: row.id,
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
    console.error(e);
    res.status(500).json({ error: "Login failed." });
  }
});

// CURRENT USER
app.get("/api/me", auth, (req, res) => {
  const user = db.prepare(
    "SELECT id,name,email,role,plan,created_at FROM users WHERE id=?"
  ).get(req.user.id);

  if (!user) {
    return res.status(404).json({ error: "Account not found." });
  }

  res.json({ user });
});

// HISTORY
app.get("/api/history", auth, (req, res) => {
  const history = db.prepare(
    "SELECT id,question,answer,subject,created_at FROM chats WHERE user_id=? ORDER BY id DESC LIMIT 50"
  ).all(req.user.id);

  res.json({ history });
});

// DELETE HISTORY
app.delete("/api/history/:id", auth, (req, res) => {
  db.prepare(
    "DELETE FROM chats WHERE id=? AND user_id=?"
  ).run(Number(req.params.id), req.user.id);

  res.json({ ok: true });
});

// SOLVE QUESTION USING CLOUDFLARE AI
app.post("/api/solve", auth, upload.single("image"), async (req, res) => {
  try {
    if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
      return res.status(503).json({
        error: "Cloudflare configuration is missing."
      });
    }

    const {
      question = "",
      subject = "General",
      language = "English",
      level = "School"
    } = req.body;

    if (!question.trim() && !req.file) {
      return res.status(400).json({
        error: "Type a question or upload an image."
      });
    }

    if (req.file && !["image/jpeg", "image/png", "image/webp"].includes(req.file.mimetype)) {
      return res.status(400).json({
        error: "Use JPG, PNG or WEBP."
      });
    }

    const userContent = [
      {
        type: "text",
        text: `You are StudyBuddy, a patient and accurate tutor.
Subject: ${subject}.
Level: ${level}.
Reply in ${language}.
Explain step by step with examples when useful.
Student question: ${question || "Read and solve the attached question."}`
      }
    ];

    if (req.file) {
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`
        }
      });
    }

    const response = await ai().chat.completions.create({
      model: "@cf/google/gemma-4-26b-a4b-it",
      messages: [
        { role: "user", content: userContent }
      ],
      max_tokens: 1200
    });

    const answer =
      response.choices?.[0]?.message?.content || "Please try again.";

    db.prepare(
      "INSERT INTO chats(user_id,question,answer,subject) VALUES(?,?,?,?)"
    ).run(req.user.id, question || "[Image question]", answer, subject);

    res.json({ answer });

  } catch (e) {
    console.error("AI ERROR:", e);
    res.status(500).json({
      error: "Could not solve this right now. Check the server configuration and try again."
    });
  }
});

// ADMIN OVERVIEW
app.get("/api/admin/overview", auth, admin, (req, res) => {
  const users = db.prepare(
    "SELECT id,name,email,role,plan,created_at FROM users ORDER BY id DESC LIMIT 200"
  ).all();

  const totals = db.prepare(
    "SELECT COUNT(*) AS users FROM users"
  ).get();

  const doubts = db.prepare(
    "SELECT COUNT(*) AS doubts FROM chats"
  ).get();

  res.json({
    users,
    totalUsers: totals.users,
    totalDoubts: doubts.doubts
  });
});

// UPDATE USER PLAN
app.patch("/api/admin/users/:id/plan", auth, admin, (req, res) => {
  const plan = ["free", "premium"].includes(req.body?.plan)
    ? req.body.plan
    : null;

  if (!plan) {
    return res.status(400).json({ error: "Plan must be free or premium." });
  }

  db.prepare(
    "UPDATE users SET plan=? WHERE id=?"
  ).run(plan, Number(req.params.id));

  res.json({ ok: true });
});

// START SERVER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`StudyBuddy running on port ${PORT}`);
});
 
