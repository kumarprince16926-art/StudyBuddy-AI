
import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";

const { Pool } = pg;

const app = express();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing.");
}

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is missing.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err);
});

const jwtSecret = process.env.JWT_SECRET;

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const ai = () => new OpenAI({
  apiKey: process.env.CLOUDFLARE_API_TOKEN,
  baseURL: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`
});

// DATABASE SETUP
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

    CREATE INDEX IF NOT EXISTS chats_user_id_idx
    ON chats(user_id);
  `);

  console.log("PostgreSQL database connected successfully.");
}

// AUTHENTICATION
function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || "")
      .replace(/^Bearer\s+/i, "");

    if (!token) {
      return res.status(401).json({
        error: "Please sign in first."
      });
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
    return res.status(403).json({
      error: "Admin access only."
    });
  }

  next();
}

// REGISTER
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (
      !name?.trim() ||
      !email?.trim() ||
      !password ||
      password.length < 8
    ) {
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

    const token = jwt.sign(user, jwtSecret, {
      expiresIn: "7d"
    });

    res.json({ token, user });

  } catch (e) {
    console.error("REGISTER ERROR:", e);

    res.status(e.code === "23505" ? 409 : 500).json({
      error: e.code === "23505"
        ? "That email is already registered. Please sign in."
        : "Could not create account."
    });
  }
});

// LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body?.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    const row = result.rows[0];

    if (
      !row ||
      !(await bcrypt.compare(password, row.password_hash))
    ) {
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
      token: jwt.sign(user, jwtSecret, {
        expiresIn: "7d"
      }),
      user
    });

  } catch (e) {
    console.error("LOGIN ERROR:", e);

    res.status(500).json({
      error: "Login failed."
    });
  }
});

// CURRENT USER
app.get("/api/me", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,name,email,role,plan,created_at
       FROM users WHERE id=$1`,
      [req.user.id]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({
        error: "Account not found."
      });
    }

    user.id = Number(user.id);

    res.json({ user });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load account." });
  }
});

// HISTORY
app.get("/api/history", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,question,answer,subject,created_at
       FROM chats
       WHERE user_id=$1
       ORDER BY id DESC
       LIMIT 50`,
      [req.user.id]
    );

    res.json({ history: result.rows });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load history." });
  }
});

// DELETE HISTORY
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

// SOLVE QUESTION USING CLOUDFLARE AI
app.post("/api/solve", auth, upload.single("image"), async (req, res) => {
  try {
    if (
      !process.env.CLOUDFLARE_API_TOKEN ||
      !process.env.CLOUDFLARE_ACCOUNT_ID
    ) {
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

    if (
      req.file &&
      !["image/jpeg", "image/png", "image/webp"].includes(req.file.mimetype)
    ) {
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

    await pool.query(
      `INSERT INTO chats(user_id,question,answer,subject)
       VALUES($1,$2,$3,$4)`,
      [
        req.user.id,
        question || "[Image question]",
        answer,
        subject
      ]
    );

    res.json({ answer });

  } catch (e) {
    console.error("AI ERROR:", e);

    res.status(500).json({
      error: "Could not solve this right now. Check the server configuration and try again."
    });
  }
});

// ADMIN OVERVIEW
app.get("/api/admin/overview", auth, admin, async (req, res) => {
  try {
    const usersResult = await pool.query(
      `SELECT id,name,email,role,plan,created_at
       FROM users ORDER BY id DESC LIMIT 200`
    );

    const totals = await pool.query(
      "SELECT COUNT(*)::int AS users FROM users"
    );

    const doubts = await pool.query(
      "SELECT COUNT(*)::int AS doubts FROM chats"
    );

    res.json({
      users: usersResult.rows,
      totalUsers: totals.rows[0].users,
      totalDoubts: doubts.rows[0].doubts
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Could not load admin overview."
    });
  }
});

// UPDATE USER PLAN
app.patch("/api/admin/users/:id/plan", auth, admin, async (req, res) => {
  try {
    const plan = ["free", "premium"].includes(req.body?.plan)
      ? req.body.plan
      : null;

    if (!plan) {
      return res.status(400).json({
        error: "Plan must be free or premium."
      });
    }

    const result = await pool.query(
      "UPDATE users SET plan=$1 WHERE id=$2",
      [plan, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "User not found."
      });
    }

    res.json({ ok: true });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Could not update user plan."
    });
  }
});

// START SERVER
const PORT = process.env.PORT || 3000;

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`StudyBuddy running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("DATABASE STARTUP ERROR:", err);
    process.exit(1);
  });
