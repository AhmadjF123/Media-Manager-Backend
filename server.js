const express    = require("express");
const mongoose   = require("mongoose");
const cors       = require("cors");
const compression = require("compression");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "cinema-vault-secret-2024-change-in-prod";

// ==================== MongoDB Connection ====================
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://admin:admin123@cluster0.1x1ifj7.mongodb.net/media_manager?retryWrites=true&w=majority";

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  });

// ==================== Schemas ====================

const userSchema = new mongoose.Schema({
  username:   { type: String, required: true, unique: true, trim: true },
  email:      { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:   { type: String, required: true },
  created_at: { type: Date, default: Date.now },
});
const User = mongoose.model("User", userSchema);

const movieSchema = new mongoose.Schema({
  user_id:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  title:         { type: String, required: true, index: true },
  genre:         { type: String, required: true, index: true },
  release_year:  { type: Number, required: true, index: true },
  rating:        { type: Number, default: 0, index: true },
  poster_url:    { type: String, default: null },
  order_number:  { type: Number, required: true, default: 0 },
  // ── Personal fields (optional) ──
  notes:         { type: String, default: null },
  watch_status:  { type: String, enum: ["watched", "watching", "plan_to_watch", "dropped", null], default: null },
  watch_date:    { type: Date, default: null },
  favorite:      { type: Boolean, default: false },
  rewatch_count: { type: Number, default: 0 },
});

const seriesSchema = new mongoose.Schema({
  user_id:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  title:         { type: String, required: true, index: true },
  genre:         { type: String, required: true, index: true },
  release_year:  { type: Number, required: true, index: true },
  end_year:      { type: Number, default: null },
  rating:        { type: Number, default: 0, index: true },
  poster_url:    { type: String, default: null },
  order_number:  { type: Number, required: true, default: 0 },
  // ── Personal fields (optional) ──
  notes:         { type: String, default: null },
  watch_status:  { type: String, enum: ["watched", "watching", "plan_to_watch", "dropped", null], default: null },
  watch_date:    { type: Date, default: null },
  favorite:      { type: Boolean, default: false },
  rewatch_count: { type: Number, default: 0 },
});

const Movie  = mongoose.model("Movie",  movieSchema);
const Series = mongoose.model("Series", seriesSchema);

// ==================== Middleware ====================
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ==================== Auth Middleware ====================
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId   = decoded.userId;
    req.username = decoded.username;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ==================== Auth Routes ====================

// POST /api/auth/register
app.post("/api/auth/register", async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password)
    return res.status(400).json({ error: "All fields are required" });

  if (username.length < 3)
    return res.status(400).json({ error: "Username must be at least 3 characters" });

  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters" });

  try {
    const existing = await User.findOne({ $or: [{ email: email.toLowerCase() }, { username }] });
    if (existing) {
      return res.status(409).json({ error: "Username or email already in use" });
    }
    const hashed = await bcrypt.hash(password, 10);
    const user   = new User({ username, email, password: hashed });
    await user.save();

    const token = jwt.sign(
      { userId: user._id.toString(), username: user.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ success: true, token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required" });

  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const token = jwt.sign(
      { userId: user._id.toString(), username: user.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ success: true, token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me — validate token
app.get("/api/auth/me", authMiddleware, (req, res) => {
  res.json({ userId: req.userId, username: req.username });
});

// ==================== Media Routes (auth required) ====================

// GET /api/media/all — fetch all user's media with search/filter
app.get("/api/media/all", authMiddleware, async (req, res) => {
  const { search, by, type } = req.query;
  const baseFilter = { user_id: req.userId };
  let filter = { ...baseFilter };

  if (search && by) {
    if (by === "title")        filter.title        = { $regex: search, $options: "i" };
    else if (by === "genre")   filter.genre        = { $regex: search, $options: "i" };
    else if (by === "release_year") filter.release_year = parseInt(search);
    else if (by === "rating")  filter.rating       = parseFloat(search);
  }

  try {
    let movies = [], series = [];
    if (type === "all" || type === "movie") {
      movies = await Movie.find(filter).sort("order_number").lean();
    }
    if (type === "all" || type === "series") {
      series = await Series.find(filter).sort("order_number").lean();
    }

    const results = [
      ...movies.map((m) => ({ ...m, media_type: "movie" })),
      ...series.map((s) => ({ ...s, media_type: "series" })),
    ].sort((a, b) => a.order_number - b.order_number);

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/media — legacy endpoint (with auth)
app.get("/api/media", authMiddleware, async (req, res) => {
  const { type } = req.query;
  const Model = type === "movie" ? Movie : Series;
  try {
    const items = await Model.find({ user_id: req.userId }).sort("order_number").lean();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/media — add new item
app.post("/api/media", authMiddleware, async (req, res) => {
  const { type, data } = req.body;
  const Model = type === "movie" ? Movie : Series;
  try {
    const lastItem = await Model.findOne({ user_id: req.userId }).sort("-order_number");
    const newOrder = lastItem ? lastItem.order_number + 1 : 1;
    const newItem  = new Model({ ...data, user_id: req.userId, order_number: newOrder });
    await newItem.save();
    res.json({ success: true, order_number: newOrder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/media — edit an item
app.put("/api/media", authMiddleware, async (req, res) => {
  const { type, order_number, data } = req.body;
  if (!type || !order_number || !data)
    return res.status(400).json({ error: "Invalid request data" });

  const Model = type === "movie" ? Movie : Series;
  try {
    const item = await Model.findOne({ order_number, user_id: req.userId });
    if (!item)
      return res.status(404).json({ error: `Item not found with order number ${order_number}` });

    await Model.updateOne({ order_number, user_id: req.userId }, data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/media — delete an item
app.delete("/api/media", authMiddleware, async (req, res) => {
  const { type, order_number } = req.body;
  const Model = type === "movie" ? Movie : Series;
  try {
    await Model.deleteOne({ order_number, user_id: req.userId });

    // Re-order remaining items for this user
    const remaining = await Model.find({ user_id: req.userId }).sort("order_number").lean();
    if (remaining.length > 0) {
      const bulkOps = remaining.map((item, i) => ({
        updateOne: {
          filter: { _id: item._id },
          update: { $set: { order_number: i + 1 } },
        },
      }));
      await Model.bulkWrite(bulkOps);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});