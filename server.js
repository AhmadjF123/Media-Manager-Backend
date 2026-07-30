const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const compression = require("compression");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "cinema-vault-secret-2024-change-in-prod";
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://admin:admin123@cluster0.1x1ifj7.mongodb.net/media_manager?retryWrites=true&w=majority";

mongoose.set("strictQuery", true);
mongoose.set("bufferCommands", false);

// ==================== Schemas & indexes ====================

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    versionKey: false,
  }
);

const commonMediaFields = {
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, required: true, trim: true },
  genre: { type: String, required: true, trim: true },
  release_year: { type: Number, required: true },
  rating: { type: Number, default: 0 },
  poster_url: { type: String, default: null },
  order_number: { type: Number, required: true, default: 0 },
  notes: { type: String, default: null },
  watch_status: {
    type: String,
    enum: ["watched", "watching", "plan_to_watch", "dropped", null],
    default: null,
  },
  watch_date: { type: Date, default: null },
  favorite: { type: Boolean, default: false },
  rewatch_count: { type: Number, default: 0 },
};

function createMediaSchema(extraFields = {}) {
  const schema = new mongoose.Schema(
    { ...commonMediaFields, ...extraFields },
    {
      timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
      versionKey: false,
    }
  );

  // The first field in every index is user_id because every media query is user-scoped.
  schema.index({ user_id: 1, order_number: 1 }, { name: "user_order_idx" });
  schema.index({ user_id: 1, _id: -1 }, { name: "user_added_idx" });
  schema.index(
    { user_id: 1, title: 1, order_number: 1 },
    {
      name: "user_title_idx",
      collation: { locale: "en", strength: 2, numericOrdering: true },
    }
  );
  schema.index({ user_id: 1, release_year: -1, order_number: -1 }, { name: "user_year_idx" });
  schema.index({ user_id: 1, rating: -1, order_number: -1 }, { name: "user_rating_idx" });
  schema.index({ user_id: 1, genre: 1 }, { name: "user_genre_idx" });

  return schema;
}

const movieSchema = createMediaSchema();
const seriesSchema = createMediaSchema({ end_year: { type: Number, default: null } });

const User = mongoose.model("User", userSchema);
const Movie = mongoose.model("Movie", movieSchema);
const Series = mongoose.model("Series", seriesSchema);

// ==================== Sorting helpers ====================

const MEDIA_SORT_ALIASES = {
  added: "_id",
  order_number: "order_number",
  title: "title",
  year: "release_year",
  release_year: "release_year",
  rating: "rating",
};

const mediaTitleCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

function parseMediaSort(query = {}) {
  const field = MEDIA_SORT_ALIASES[query.sort_by] || "order_number";
  const order = String(query.sort_order || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  return { field, order, direction: order === "desc" ? -1 : 1 };
}

function getMediaAddedTime(item) {
  if (item.created_at) {
    const createdAt = new Date(item.created_at).getTime();
    if (Number.isFinite(createdAt)) return createdAt;
  }
  if (item._id && typeof item._id.getTimestamp === "function") {
    return item._id.getTimestamp().getTime();
  }
  const objectId = String(item._id || "");
  if (/^[a-f0-9]{24}$/i.test(objectId)) return parseInt(objectId.slice(0, 8), 16) * 1000;
  return Number(item.order_number) || 0;
}

function compareMediaValues(a, b, field) {
  if (field === "title") {
    return mediaTitleCollator.compare(String(a.title || ""), String(b.title || ""));
  }
  if (field === "_id") return getMediaAddedTime(a) - getMediaAddedTime(b);
  return (Number(a[field]) || 0) - (Number(b[field]) || 0);
}

function sortMediaResults(items, field, direction) {
  return items.sort((a, b) => {
    const primary = compareMediaValues(a, b, field);
    if (primary !== 0) return primary * direction;
    return ((Number(a.order_number) || 0) - (Number(b.order_number) || 0)) * direction;
  });
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMediaFilter(userId, query = {}) {
  const filter = { user_id: userId };
  const search = String(query.search || "").trim().slice(0, 120);
  const by = String(query.by || "");
  if (!search || !by) return filter;

  if (by === "title") filter.title = { $regex: escapeRegex(search), $options: "i" };
  else if (by === "genre") filter.genre = { $regex: escapeRegex(search), $options: "i" };
  else if (by === "release_year") {
    const year = Number.parseInt(search, 10);
    if (Number.isFinite(year)) filter.release_year = year;
  } else if (by === "rating") {
    const rating = Number.parseFloat(search);
    if (Number.isFinite(rating)) filter.rating = rating;
  }
  return filter;
}

function applyQueryOptions(query, sortField, direction) {
  query.sort({ [sortField]: direction, order_number: direction }).select("-__v").lean();
  if (sortField === "title") {
    query.collation({ locale: "en", strength: 2, numericOrdering: true });
  }
  return query;
}

// ==================== Small server-side response cache ====================
// This avoids repeating the same MongoDB query during refreshes, sorting and quick navigation.

const MEDIA_CACHE_TTL_MS = Math.max(1_000, Number(process.env.MEDIA_CACHE_TTL_MS) || 20_000);
const MEDIA_CACHE_MAX_ENTRIES = Math.max(20, Number(process.env.MEDIA_CACHE_MAX_ENTRIES) || 250);
const mediaResponseCache = new Map();

function getMediaCacheKey(userId, query = {}) {
  const parts = ["type", "search", "by", "sort_by", "sort_order"].map(
    (key) => `${key}=${String(query[key] || "")}`
  );
  return `${String(userId)}|${parts.join("&")}`;
}

function getCachedMediaResponse(key) {
  const entry = mediaResponseCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    mediaResponseCache.delete(key);
    return null;
  }
  // Touch the entry so the Map behaves as a tiny LRU cache.
  mediaResponseCache.delete(key);
  mediaResponseCache.set(key, entry);
  return entry;
}

function setCachedMediaResponse(key, results) {
  mediaResponseCache.set(key, {
    body: JSON.stringify(results),
    expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
  });
  while (mediaResponseCache.size > MEDIA_CACHE_MAX_ENTRIES) {
    mediaResponseCache.delete(mediaResponseCache.keys().next().value);
  }
}

function invalidateUserMediaCache(userId) {
  const prefix = `${String(userId)}|`;
  for (const key of mediaResponseCache.keys()) {
    if (key.startsWith(prefix)) mediaResponseCache.delete(key);
  }
}

const cacheCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of mediaResponseCache.entries()) {
    if (entry.expiresAt <= now) mediaResponseCache.delete(key);
  }
}, Math.max(MEDIA_CACHE_TTL_MS, 30_000));
cacheCleanupTimer.unref();

// ==================== Middleware ====================

app.disable("x-powered-by");
app.set("etag", "strong");
app.use(compression({ threshold: 512 }));
app.use(express.json({ limit: "1mb" }));
app.use(cors());
app.use((req, res, next) => {
  res.set("Vary", "Authorization");
  res.set("Cache-Control", "private, no-cache");
  next();
});

// ==================== Auth middleware ====================

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    req.userId = decoded.userId;
    req.username = decoded.username;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ==================== Health routes ====================

app.get("/", (_req, res) => {
  res.json({ service: "media-manager-backend", status: "ok" });
});
app.get("/api/health", (_req, res) => {
  res.json({
    status: mongoose.connection.readyState === 1 ? "ok" : "starting",
    database: mongoose.connection.readyState === 1 ? "connected" : "connecting",
    cache_entries: mediaResponseCache.size,
  });
});

// ==================== Auth routes ====================

app.post("/api/auth/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: "All fields are required" });
  if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  try {
    const existing = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username }],
    })
      .select("_id")
      .lean();
    if (existing) return res.status(409).json({ error: "Username or email already in use" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hashed });
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

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  try {
    const user = await User.findOne({ email: email.toLowerCase() }).lean();
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

app.get("/api/auth/me", authMiddleware, (req, res) => {
  res.json({ userId: req.userId, username: req.username });
});

// ==================== Media routes ====================

app.get("/api/media/all", authMiddleware, async (req, res) => {
  const type = ["movie", "series"].includes(req.query.type) ? req.query.type : "all";
  const { field: sortField, order: sortOrder, direction } = parseMediaSort(req.query);
  const cacheKey = getMediaCacheKey(req.userId, { ...req.query, type });
  const cached = getCachedMediaResponse(cacheKey);

  if (cached) {
    res.set("X-Data-Cache", "HIT");
    res.set("X-Media-Sort", `${sortField}:${sortOrder}`);
    return res.type("application/json").send(cached.body);
  }

  try {
    const filter = buildMediaFilter(req.userId, req.query);
    const moviePromise = type === "all" || type === "movie"
      ? applyQueryOptions(Movie.find(filter), sortField, direction).exec()
      : Promise.resolve([]);
    const seriesPromise = type === "all" || type === "series"
      ? applyQueryOptions(Series.find(filter), sortField, direction).exec()
      : Promise.resolve([]);

    // Movies and series are fetched concurrently instead of one after the other.
    const [movies, series] = await Promise.all([moviePromise, seriesPromise]);
    const results = sortMediaResults(
      [
        ...movies.map((item) => ({ ...item, media_type: "movie" })),
        ...series.map((item) => ({ ...item, media_type: "series" })),
      ],
      sortField,
      direction
    );

    setCachedMediaResponse(cacheKey, results);
    res.set("X-Data-Cache", "MISS");
    res.set("X-Media-Sort", `${sortField}:${sortOrder}`);
    res.type("application/json").send(JSON.stringify(results));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/media", authMiddleware, async (req, res) => {
  const type = req.query.type === "movie" ? "movie" : "series";
  const Model = type === "movie" ? Movie : Series;
  const { field: sortField, order: sortOrder, direction } = parseMediaSort(req.query);
  const cacheKey = getMediaCacheKey(req.userId, { ...req.query, type });
  const cached = getCachedMediaResponse(cacheKey);

  if (cached) {
    res.set("X-Data-Cache", "HIT");
    res.set("X-Media-Sort", `${sortField}:${sortOrder}`);
    return res.type("application/json").send(cached.body);
  }

  try {
    const filter = buildMediaFilter(req.userId, req.query);
    const items = await applyQueryOptions(Model.find(filter), sortField, direction).exec();
    sortMediaResults(items, sortField, direction);
    setCachedMediaResponse(cacheKey, items);
    res.set("X-Data-Cache", "MISS");
    res.set("X-Media-Sort", `${sortField}:${sortOrder}`);
    res.type("application/json").send(JSON.stringify(items));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sanitizeMediaData(data = {}, type) {
  const allowed = [
    "title",
    "genre",
    "release_year",
    "rating",
    "poster_url",
    "notes",
    "watch_status",
    "watch_date",
    "favorite",
    "rewatch_count",
  ];
  if (type === "series") allowed.push("end_year");
  return Object.fromEntries(allowed.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]));
}

app.post("/api/media", authMiddleware, async (req, res) => {
  const type = req.body.type === "series" ? "series" : "movie";
  const Model = type === "movie" ? Movie : Series;
  const data = sanitizeMediaData(req.body.data, type);

  try {
    const lastItem = await Model.findOne({ user_id: req.userId })
      .sort({ order_number: -1 })
      .select("order_number")
      .lean();
    const newOrder = (Number(lastItem?.order_number) || 0) + 1;
    const newItem = await Model.create({
      ...data,
      user_id: req.userId,
      order_number: newOrder,
    });

    invalidateUserMediaCache(req.userId);
    res.status(201).json({
      success: true,
      order_number: newOrder,
      item: { ...newItem.toObject(), media_type: type },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/media", authMiddleware, async (req, res) => {
  const type = req.body.type === "series" ? "series" : "movie";
  const orderNumber = Number.parseInt(req.body.order_number, 10);
  const data = sanitizeMediaData(req.body.data, type);
  if (!orderNumber || !Object.keys(data).length) {
    return res.status(400).json({ error: "Invalid request data" });
  }

  const Model = type === "movie" ? Movie : Series;
  try {
    // One indexed query replaces the old find + update pair.
    const updated = await Model.findOneAndUpdate(
      { user_id: req.userId, order_number: orderNumber },
      { $set: data },
      { new: true, runValidators: true }
    )
      .select("-__v")
      .lean();

    if (!updated) {
      return res.status(404).json({ error: `Item not found with order number ${orderNumber}` });
    }

    invalidateUserMediaCache(req.userId);
    res.json({ success: true, item: { ...updated, media_type: type } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/media", authMiddleware, async (req, res) => {
  const type = req.body.type === "series" ? "series" : "movie";
  const orderNumber = Number.parseInt(req.body.order_number, 10);
  const Model = type === "movie" ? Movie : Series;

  try {
    const deleted = await Model.deleteOne({ user_id: req.userId, order_number: orderNumber });
    if (!deleted.deletedCount) return res.status(404).json({ error: "Item not found" });

    // Keep order numbers stable. Avoiding a full collection re-number makes deletes instant
    // and prevents concurrent edits from targeting a different item after a deletion.
    invalidateUserMediaCache(req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Startup ====================

async function ensureIndexes() {
  try {
    await Promise.all([User.createIndexes(), Movie.createIndexes(), Series.createIndexes()]);
    console.log("✅ MongoDB indexes are ready");
  } catch (err) {
    // The API can still run while an index issue is investigated.
    console.error("⚠️ Index creation warning:", err.message);
  }
}

async function startServer() {
  try {
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 20,
      minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 1,
      maxIdleTimeMS: 60_000,
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 45_000,
      family: 4,
    });
    console.log("✅ Connected to MongoDB");

    app.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
    });

    // Build missing compound indexes in the background so startup stays fast.
    ensureIndexes();
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

process.on("SIGTERM", async () => {
  await mongoose.connection.close();
  process.exit(0);
});

startServer();
