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
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student',
 plan TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chats (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
 question TEXT NOT NULL, answer TEXT NOT NULL, subject TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id)
);`);
app.use(express.json({limit:"1mb"}));
app.use(express.static("public"));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024}});
const jwtSecret=process.env.JWT_SECRET;
const ai=()=>new OpenAI({apiKey:process.env.OPENAI_API_KEY});

function auth(req,res,next){
 try {
  const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  if(!token||!jwtSecret) return res.status(401).json({error:"Please sign in first."});
  req.user=jwt.verify(token,jwtSecret); next();
 } catch { return res.status(401).json({error:"Session expired. Please sign in again."}); }
}
function admin(req,res,next){ if(req.user.role!=="admin") return res.status(403).json({error:"Admin access only."}); next(); }

app.post("/api/register", async(req,res)=>{
 try{
  const {name,email,password}=req.body||{};
  if(!name?.trim()||!email?.trim()||!password||password.length<8) return res.status(400).json({error:"Enter your name, a valid email and a password of at least 8 characters."});
  const clean=email.trim().toLowerCase();
  const role=clean===process.env.ADMIN_EMAIL?.trim().toLowerCase()?"admin":"student";
  const hash=await bcrypt.hash(password,12);
  const result=db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)").run(name.trim(),clean,hash,role);
  const user={id:Number(result.lastInsertRowid),name:name.trim(),email:clean,role,plan:"free"};
  const token=jwt.sign(user,jwtSecret,{expiresIn:"7d"});
  res.json({token,user});
 }catch(e){res.status(409).json({error:e.code==="SQLITE_CONSTRAINT_UNIQUE"?"That email is already registered.":"Could not create account."});}
});
app.post("/api/login",async(req,res)=>{
 const email=String(req.body?.email||"").trim().toLowerCase(), password=String(req.body?.password||"");
 const row=db.prepare("SELECT * FROM users WHERE email=?").get(email);
 if(!row||!(await bcrypt.compare(password,row.password_hash))) return res.status(401).json({error:"Email or password is incorrect."});
 const user={id:row.id,name:row.name,email:row.email,role:row.role,plan:row.plan};
 res.json({token:jwt.sign(user,jwtSecret,{expiresIn:"7d"}),user});
});
app.get("/api/me",auth,(req,res)=>{
 const u=db.prepare("SELECT id,name,email,role,plan,created_at FROM users WHERE id=?").get(req.user.id);
 if(!u)return res.status(404).json({error:"Account not found."}); res.json({user:u});
});
app.get("/api/history",auth,(req,res)=>{
 const rows=db.prepare("SELECT id,question,answer,subject,created_at FROM chats WHERE user_id=? ORDER BY id DESC LIMIT 50").all(req.user.id);
 res.json({history:rows});
});
app.delete("/api/history/:id",auth,(req,res)=>{
 db.prepare("DELETE FROM chats WHERE id=? AND user_id=?").run(Number(req.params.id),req.user.id);res.json({ok:true});
});
app.post("/api/solve",auth,upload.single("image"),async(req,res)=>{
 try{
  if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:"Add OPENAI_API_KEY to the server .env file."});
  const {question="",subject="General",language="English",level="School"}=req.body;
  if(!question.trim()&&!req.file)return res.status(400).json({error:"Type a question or upload an image."});
  const content=[{type:"input_text",text:`You are StudyBuddy, a patient, accurate tutor. Subject: ${subject}. Level: ${level}. Reply in ${language}. Teach step by step, not just the answer. Explain the concept, givens, formula, calculation and final answer when relevant. If the image is unclear, ask for a clearer one. Student question: ${question||"Read and solve the attached question."}`}];
  if(req.file){
   if(!["image/jpeg","image/png","image/webp","image/gif"].includes(req.file.mimetype))return res.status(400).json({error:"Use JPG, PNG, WEBP or GIF."});
   content.push({type:"input_image",image_url:`data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`});
  }
  const response=await ai().responses.create({model:"gpt-4.1-mini",input:[{role:"user",content}]});
  const answer=response.output_text||"I couldn't produce an answer. Please try again.";
  db.prepare("INSERT INTO chats(user_id,question,answer,subject) VALUES(?,?,?,?)").run(req.user.id,question||"[Image question]",answer,subject);
  res.json({answer});
 }catch(e){console.error(e);res.status(500).json({error:"Could not solve this right now. Check the server configuration and try again."});}
});
app.get("/api/admin/overview",auth,admin,(req,res)=>{
 const users=db.prepare("SELECT id,name,email,role,plan,created_at FROM users ORDER BY id DESC LIMIT 200").all();
 const totals=db.prepare("SELECT COUNT(*) AS users FROM users").get();
 const doubts=db.prepare("SELECT COUNT(*) AS doubts FROM chats").get();
 res.json({users,totalUsers:totals.users,totalDoubts:doubts.doubts});
});
app.patch("/api/admin/users/:id/plan",auth,admin,(req,res)=>{
 const plan=["free","premium"].includes(req.body?.plan)?req.body.plan:null;
 if(!plan)return res.status(400).json({error:"Plan must be free or premium."});
 db.prepare("UPDATE users SET plan=? WHERE id=?").run(plan,Number(req.params.id));res.json({ok:true});
});
app.listen(process.env.PORT||3000,()=>console.log(`StudyBuddy running on http://localhost:${process.env.PORT||3000}`));
