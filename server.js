const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const compression = require("compression");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

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
    // username is the public handle shown as @username. username_key is the
    // case-insensitive canonical value used for search and uniqueness.
    username: { type: String, required: true, unique: true, trim: true },
    username_key: { type: String, required: true, unique: true, trim: true, lowercase: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    discoverable: { type: Boolean, default: true },
    allow_friend_requests: { type: Boolean, default: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    versionKey: false,
  }
);
userSchema.index({ discoverable: 1, username_key: 1 }, { name: "discoverable_username_idx" });

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
  schema.index({ user_id: 1, watch_status: 1, updated_at: -1 }, { name: "user_watch_status_idx" });
  schema.index({ user_id: 1, favorite: 1, updated_at: -1 }, { name: "user_favorite_idx" });

  return schema;
}

const movieSchema = createMediaSchema();
const seriesSchema = createMediaSchema({
  end_year: { type: Number, default: null },
  number_of_seasons: { type: Number, min: 1, default: null },
});

const friendshipSchema = new mongoose.Schema(
  {
    pair_key: { type: String, required: true, unique: true },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }],
    accepted_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" }, versionKey: false }
);
friendshipSchema.index({ participants: 1, created_at: -1 }, { name: "friend_participants_idx" });

const friendRequestSchema = new mongoose.Schema(
  {
    pair_key: { type: String, required: true, unique: true },
    sender_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    recipient_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" }, versionKey: false }
);
friendRequestSchema.index({ recipient_id: 1, created_at: -1 }, { name: "incoming_requests_idx" });
friendRequestSchema.index({ sender_id: 1, created_at: -1 }, { name: "outgoing_requests_idx" });

const friendPermissionSchema = new mongoose.Schema(
  {
    owner_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    viewer_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    watching: { type: Boolean, default: true },
    watched: { type: Boolean, default: true },
    favorites: { type: Boolean, default: true },
    ratings: { type: Boolean, default: true },
    full_collection: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" }, versionKey: false }
);
friendPermissionSchema.index(
  { owner_id: 1, viewer_id: 1 },
  { unique: true, name: "owner_viewer_permission_idx" }
);

const blockSchema = new mongoose.Schema(
  {
    pair_key: { type: String, required: true, unique: true },
    blocker_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    blocked_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" }, versionKey: false }
);
blockSchema.index({ blocker_id: 1, created_at: -1 }, { name: "blocker_idx" });

const inviteCodeSchema = new mongoose.Schema(
  {
    code_hash: { type: String, required: true, unique: true },
    owner_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    expires_at: { type: Date, required: true },
    used_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    used_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" }, versionKey: false }
);
inviteCodeSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: "invite_expiry_ttl" });
inviteCodeSchema.index({ owner_id: 1, created_at: -1 }, { name: "invite_owner_idx" });

const User = mongoose.model("User", userSchema);
const Movie = mongoose.model("Movie", movieSchema);
const Series = mongoose.model("Series", seriesSchema);
const Friendship = mongoose.model("Friendship", friendshipSchema);
const FriendRequest = mongoose.model("FriendRequest", friendRequestSchema);
const FriendPermission = mongoose.model("FriendPermission", friendPermissionSchema);
const Block = mongoose.model("Block", blockSchema);
const InviteCode = mongoose.model("InviteCode", inviteCodeSchema);

// ==================== Identity & social helpers ====================

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const DEFAULT_SHARING = Object.freeze({
  watching: true,
  watched: true,
  favorites: true,
  ratings: true,
  full_collection: false,
});

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

function sanitizeLegacyUsername(value) {
  let key = normalizeUsername(value)
    .replace(/[\s.-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  if (key.length < 3) key = `user_${key || "member"}`.slice(0, 20);
  return key;
}

function socialPairKey(a, b) {
  return [String(a), String(b)].sort().join(":");
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: String(user._id),
    username: user.username,
    discoverable: user.discoverable !== false,
    allow_friend_requests: user.allow_friend_requests !== false,
  };
}

async function areFriends(userA, userB) {
  return Boolean(await Friendship.exists({ pair_key: socialPairKey(userA, userB) }));
}

async function hasBlockBetween(userA, userB) {
  return Boolean(await Block.exists({ pair_key: socialPairKey(userA, userB) }));
}

async function createPendingFriendRequest(senderId, recipient, { allowByInvite = false } = {}) {
  if (String(senderId) === String(recipient._id)) {
    const err = new Error("You cannot add yourself");
    err.status = 400;
    throw err;
  }
  if (!allowByInvite && recipient.allow_friend_requests === false) {
    const err = new Error("This user is not accepting friend requests");
    err.status = 403;
    throw err;
  }

  const pair_key = socialPairKey(senderId, recipient._id);
  const [blocked, friendship, existing] = await Promise.all([
    Block.exists({ pair_key }),
    Friendship.exists({ pair_key }),
    FriendRequest.findOne({ pair_key }).lean(),
  ]);
  if (blocked) {
    const err = new Error("Friend request is unavailable");
    err.status = 403;
    throw err;
  }
  if (friendship) {
    const err = new Error("You are already friends");
    err.status = 409;
    throw err;
  }
  if (existing) {
    const err = new Error(
      String(existing.sender_id) === String(senderId)
        ? "Friend request already sent"
        : "This user already sent you a request"
    );
    err.status = 409;
    throw err;
  }

  return FriendRequest.create({ pair_key, sender_id: senderId, recipient_id: recipient._id });
}

function hashInviteCode(code) {
  return crypto.createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex");
}

function makeInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  return `CINEMA-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function cleanPermissions(input = {}) {
  return {
    watching: Boolean(input.watching),
    watched: Boolean(input.watched),
    favorites: Boolean(input.favorites),
    ratings: Boolean(input.ratings),
    full_collection: Boolean(input.full_collection),
  };
}

function relationshipLabel({ friendship, request, currentUserId }) {
  if (friendship) return "friends";
  if (!request) return "none";
  return String(request.sender_id) === String(currentUserId) ? "outgoing" : "incoming";
}

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

app.post("/api/auth/username-availability", async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      available: false,
      error: "Use 3–20 lowercase letters, numbers, or underscores",
    });
  }
  try {
    const exists = await User.exists({ username_key: username });
    res.json({ available: !exists, username });
  } catch (err) {
    res.status(500).json({ available: false, error: err.message });
  }
});

app.post("/api/auth/register", async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const confirmProvided = Object.hasOwn(req.body || {}, "confirm_password") || Object.hasOwn(req.body || {}, "confirmPassword");
  const confirmPassword = String(req.body?.confirm_password ?? req.body?.confirmPassword ?? "");

  if (!username || !email || !password) {
    return res.status(400).json({ error: "All fields are required" });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "Username must be 3–20 lowercase letters, numbers, or underscores" });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  if (confirmProvided && password !== confirmPassword) {
    return res.status(400).json({ error: "Passwords do not match" });
  }

  try {
    const existing = await User.findOne({
      $or: [{ email }, { username_key: username }],
    }).select("email username_key").lean();
    if (existing?.email === email) return res.status(409).json({ error: "Email already in use", field: "email" });
    if (existing) return res.status(409).json({ error: "Username is already taken", field: "username" });

    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({
      username,
      username_key: username,
      email,
      password: hashed,
      discoverable: true,
      allow_friend_requests: true,
    });
    const token = jwt.sign(
      { userId: user._id.toString(), username: user.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.status(201).json({ success: true, token, username: user.username, user: publicUser(user) });
  } catch (err) {
    if (err?.code === 11000) {
      const field = err.keyPattern?.email ? "email" : "username";
      return res.status(409).json({
        error: field === "email" ? "Email already in use" : "Username is already taken",
        field,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  try {
    const user = await User.findOne({ email }).lean();
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const token = jwt.sign(
      { userId: user._id.toString(), username: user.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ success: true, token, username: user.username, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const [user, pendingRequests] = await Promise.all([
      User.findById(req.userId).select("username discoverable allow_friend_requests").lean(),
      FriendRequest.countDocuments({ recipient_id: req.userId }),
    ]);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ ...publicUser(user), pending_requests_count: pendingRequests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/auth/settings", authMiddleware, async (req, res) => {
  const updates = {};
  if (typeof req.body?.discoverable === "boolean") updates.discoverable = req.body.discoverable;
  if (typeof req.body?.allow_friend_requests === "boolean") {
    updates.allow_friend_requests = req.body.allow_friend_requests;
  }
  try {
    const user = await User.findByIdAndUpdate(req.userId, { $set: updates }, { new: true })
      .select("username discoverable allow_friend_requests")
      .lean();
    res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Friends, people search & sharing ====================

app.get("/api/social/search", authMiddleware, async (req, res) => {
  const q = normalizeUsername(req.query.q).slice(0, 20);
  if (q.length < 2) return res.json([]);
  try {
    const blocked = await Block.find({
      $or: [{ blocker_id: req.userId }, { blocked_id: req.userId }],
    }).select("blocker_id blocked_id").lean();
    const blockedIds = blocked.map((entry) =>
      String(entry.blocker_id) === String(req.userId) ? entry.blocked_id : entry.blocker_id
    );

    const users = await User.find({
      _id: { $ne: req.userId, $nin: blockedIds },
      discoverable: true,
      username_key: { $regex: `^${escapeRegex(q)}` },
    })
      .select("username discoverable allow_friend_requests")
      .sort({ username_key: 1 })
      .limit(12)
      .lean();

    const pairKeys = users.map((user) => socialPairKey(req.userId, user._id));
    const [friendships, requests] = await Promise.all([
      Friendship.find({ pair_key: { $in: pairKeys } }).select("pair_key").lean(),
      FriendRequest.find({ pair_key: { $in: pairKeys } }).select("_id pair_key sender_id recipient_id").lean(),
    ]);
    const friendshipMap = new Map(friendships.map((item) => [item.pair_key, item]));
    const requestMap = new Map(requests.map((item) => [item.pair_key, item]));

    res.json(users.map((user) => {
      const key = socialPairKey(req.userId, user._id);
      const request = requestMap.get(key) || null;
      return {
        ...publicUser(user),
        relationship: relationshipLabel({
          friendship: friendshipMap.get(key),
          request,
          currentUserId: req.userId,
        }),
        request_id: request ? String(request._id) : null,
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/social/requests", authMiddleware, async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  try {
    const recipient = await User.findOne({ username_key: username })
      .select("username allow_friend_requests")
      .lean();
    if (!recipient) return res.status(404).json({ error: "User not found" });
    const request = await createPendingFriendRequest(req.userId, recipient);
    res.status(201).json({ success: true, request_id: String(request._id), user: publicUser(recipient) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/social/requests", authMiddleware, async (req, res) => {
  try {
    const [incoming, outgoing] = await Promise.all([
      FriendRequest.find({ recipient_id: req.userId })
        .sort({ created_at: -1 })
        .populate("sender_id", "username discoverable allow_friend_requests")
        .lean(),
      FriendRequest.find({ sender_id: req.userId })
        .sort({ created_at: -1 })
        .populate("recipient_id", "username discoverable allow_friend_requests")
        .lean(),
    ]);
    res.json({
      incoming: incoming.map((item) => ({
        id: String(item._id),
        user: publicUser(item.sender_id),
        created_at: item.created_at,
      })).filter((item) => item.user),
      outgoing: outgoing.map((item) => ({
        id: String(item._id),
        user: publicUser(item.recipient_id),
        created_at: item.created_at,
      })).filter((item) => item.user),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/social/requests/:id/accept", authMiddleware, async (req, res) => {
  try {
    const request = await FriendRequest.findOne({ _id: req.params.id, recipient_id: req.userId }).lean();
    if (!request) return res.status(404).json({ error: "Friend request not found" });
    if (await hasBlockBetween(request.sender_id, request.recipient_id)) {
      return res.status(403).json({ error: "Friend request is unavailable" });
    }

    await Friendship.findOneAndUpdate(
      { pair_key: request.pair_key },
      {
        $setOnInsert: {
          pair_key: request.pair_key,
          participants: [request.sender_id, request.recipient_id],
          accepted_by: req.userId,
        },
      },
      { upsert: true, new: true }
    );
    await Promise.all([
      FriendPermission.findOneAndUpdate(
        { owner_id: request.sender_id, viewer_id: request.recipient_id },
        { $setOnInsert: DEFAULT_SHARING },
        { upsert: true }
      ),
      FriendPermission.findOneAndUpdate(
        { owner_id: request.recipient_id, viewer_id: request.sender_id },
        { $setOnInsert: DEFAULT_SHARING },
        { upsert: true }
      ),
      FriendRequest.deleteOne({ _id: request._id }),
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/social/requests/:id/decline", authMiddleware, async (req, res) => {
  try {
    const result = await FriendRequest.deleteOne({ _id: req.params.id, recipient_id: req.userId });
    if (!result.deletedCount) return res.status(404).json({ error: "Friend request not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/social/requests/:id", authMiddleware, async (req, res) => {
  try {
    const result = await FriendRequest.deleteOne({ _id: req.params.id, sender_id: req.userId });
    if (!result.deletedCount) return res.status(404).json({ error: "Friend request not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/social/friends", authMiddleware, async (req, res) => {
  try {
    const friendships = await Friendship.find({ participants: req.userId }).sort({ created_at: -1 }).lean();
    const friendIds = friendships.map((item) =>
      item.participants.find((id) => String(id) !== String(req.userId))
    );
    const [users, permissions] = await Promise.all([
      User.find({ _id: { $in: friendIds } }).select("username discoverable allow_friend_requests").lean(),
      FriendPermission.find({ owner_id: req.userId, viewer_id: { $in: friendIds } }).lean(),
    ]);
    const userMap = new Map(users.map((user) => [String(user._id), user]));
    const permissionMap = new Map(permissions.map((permission) => [String(permission.viewer_id), permission]));
    res.json(friendIds.map((id) => {
      const permission = permissionMap.get(String(id));
      return {
        ...publicUser(userMap.get(String(id))),
        sharing: permission ? cleanPermissions(permission) : { ...DEFAULT_SHARING },
      };
    }).filter((item) => item.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/social/friends/:username", authMiddleware, async (req, res) => {
  try {
    const other = await User.findOne({ username_key: normalizeUsername(req.params.username) }).select("_id").lean();
    if (!other) return res.status(404).json({ error: "User not found" });
    const pair_key = socialPairKey(req.userId, other._id);
    const friendship = await Friendship.deleteOne({ pair_key });
    if (!friendship.deletedCount) return res.status(404).json({ error: "Friendship not found" });
    await FriendPermission.deleteMany({
      $or: [
        { owner_id: req.userId, viewer_id: other._id },
        { owner_id: other._id, viewer_id: req.userId },
      ],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/social/friends/:username/permissions", authMiddleware, async (req, res) => {
  try {
    const viewer = await User.findOne({ username_key: normalizeUsername(req.params.username) }).select("_id username").lean();
    if (!viewer) return res.status(404).json({ error: "User not found" });
    if (!(await areFriends(req.userId, viewer._id))) return res.status(403).json({ error: "You are not friends" });
    const permission = await FriendPermission.findOne({ owner_id: req.userId, viewer_id: viewer._id }).lean();
    res.json({ user: publicUser(viewer), permissions: permission ? cleanPermissions(permission) : { ...DEFAULT_SHARING } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/social/friends/:username/permissions", authMiddleware, async (req, res) => {
  try {
    const viewer = await User.findOne({ username_key: normalizeUsername(req.params.username) }).select("_id username").lean();
    if (!viewer) return res.status(404).json({ error: "User not found" });
    if (!(await areFriends(req.userId, viewer._id))) return res.status(403).json({ error: "You are not friends" });
    const permissions = cleanPermissions(req.body || {});
    await FriendPermission.findOneAndUpdate(
      { owner_id: req.userId, viewer_id: viewer._id },
      { $set: permissions },
      { upsert: true, new: true, runValidators: true }
    );
    res.json({ success: true, permissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/social/block/:username", authMiddleware, async (req, res) => {
  try {
    const blocked = await User.findOne({ username_key: normalizeUsername(req.params.username) }).select("_id username").lean();
    if (!blocked) return res.status(404).json({ error: "User not found" });
    if (String(blocked._id) === String(req.userId)) return res.status(400).json({ error: "You cannot block yourself" });
    const pair_key = socialPairKey(req.userId, blocked._id);
    await Promise.all([
      Block.findOneAndUpdate(
        { pair_key },
        { $setOnInsert: { blocker_id: req.userId, blocked_id: blocked._id } },
        { upsert: true }
      ),
      Friendship.deleteOne({ pair_key }),
      FriendRequest.deleteOne({ pair_key }),
      FriendPermission.deleteMany({
        $or: [
          { owner_id: req.userId, viewer_id: blocked._id },
          { owner_id: blocked._id, viewer_id: req.userId },
        ],
      }),
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/social/block/:username", authMiddleware, async (req, res) => {
  try {
    const blocked = await User.findOne({ username_key: normalizeUsername(req.params.username) }).select("_id").lean();
    if (!blocked) return res.status(404).json({ error: "User not found" });
    await Block.deleteOne({ pair_key: socialPairKey(req.userId, blocked._id), blocker_id: req.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/social/blocked", authMiddleware, async (req, res) => {
  try {
    const blocks = await Block.find({ blocker_id: req.userId })
      .sort({ created_at: -1 })
      .populate("blocked_id", "username discoverable allow_friend_requests")
      .lean();
    res.json(blocks.map((entry) => publicUser(entry.blocked_id)).filter(Boolean));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/social/invites", authMiddleware, async (req, res) => {
  try {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    let rawCode;
    let created;
    for (let attempt = 0; attempt < 4 && !created; attempt += 1) {
      rawCode = makeInviteCode();
      try {
        created = await InviteCode.create({
          code_hash: hashInviteCode(rawCode),
          owner_id: req.userId,
          expires_at: expiresAt,
        });
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
    }
    if (!created) throw new Error("Could not create invite code");
    res.status(201).json({ success: true, code: rawCode, expires_at: expiresAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/social/invites/join", authMiddleware, async (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  try {
    const invite = await InviteCode.findOne({
      code_hash: hashInviteCode(code),
      expires_at: { $gt: new Date() },
      used_at: null,
    }).lean();
    if (!invite) return res.status(404).json({ error: "Invite code is invalid or expired" });
    if (String(invite.owner_id) === String(req.userId)) {
      return res.status(400).json({ error: "You cannot use your own invite" });
    }
    const owner = await User.findById(invite.owner_id).select("username allow_friend_requests").lean();
    if (!owner) return res.status(404).json({ error: "Invite owner no longer exists" });
    const request = await createPendingFriendRequest(req.userId, owner, { allowByInvite: true });
    await InviteCode.updateOne(
      { _id: invite._id, used_at: null },
      { $set: { used_by: req.userId, used_at: new Date() } }
    );
    res.status(201).json({ success: true, request_id: String(request._id), user: publicUser(owner) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/social/friends/:username/vault", authMiddleware, async (req, res) => {
  try {
    const owner = await User.findOne({ username_key: normalizeUsername(req.params.username) })
      .select("_id username")
      .lean();
    if (!owner) return res.status(404).json({ error: "User not found" });
    if (!(await areFriends(req.userId, owner._id))) return res.status(403).json({ error: "You are not friends" });

    const permissionDoc = await FriendPermission.findOne({ owner_id: owner._id, viewer_id: req.userId }).lean();
    const permissions = permissionDoc ? cleanPermissions(permissionDoc) : { ...DEFAULT_SHARING };
    const filter = { user_id: owner._id };
    if (!permissions.full_collection) {
      const visibility = [];
      if (permissions.watching) visibility.push({ watch_status: "watching" });
      if (permissions.watched) visibility.push({ watch_status: "watched" });
      if (permissions.favorites) visibility.push({ favorite: true });
      if (!visibility.length) {
        return res.json({ owner: publicUser(owner), permissions, items: [], stats: { total: 0, movies: 0, series: 0 } });
      }
      filter.$or = visibility;
    }

    const [movies, series] = await Promise.all([
      Movie.find(filter).sort({ updated_at: -1, order_number: -1 }).select("-notes -__v").lean(),
      Series.find(filter).sort({ updated_at: -1, order_number: -1 }).select("-notes -__v").lean(),
    ]);
    const sanitizeShared = (item, media_type) => ({
      ...item,
      user_id: undefined,
      media_type,
      rating: permissions.ratings ? item.rating : null,
      notes: undefined,
    });
    const items = [
      ...movies.map((item) => sanitizeShared(item, "movie")),
      ...series.map((item) => sanitizeShared(item, "series")),
    ].sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

    res.json({
      owner: publicUser(owner),
      permissions,
      items,
      stats: {
        total: items.length,
        movies: items.filter((item) => item.media_type === "movie").length,
        series: items.filter((item) => item.media_type === "series").length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  if (type === "series") allowed.push("end_year", "number_of_seasons");
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

async function ensureLegacyUsernameKeys() {
  const users = await User.find({
    $or: [{ username_key: { $exists: false } }, { username_key: null }, { username_key: "" }],
  }).select("_id username").lean();
  const used = new Set(
    (await User.find({ username_key: { $exists: true, $ne: "" } }).select("username_key").lean())
      .map((user) => user.username_key)
  );
  for (const user of users) {
    const base = sanitizeLegacyUsername(user.username);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      const tail = `_${suffix++}`;
      candidate = `${base.slice(0, 20 - tail.length)}${tail}`;
    }
    used.add(candidate);
    await User.updateOne(
      { _id: user._id },
      { $set: { username_key: candidate, discoverable: true, allow_friend_requests: true } }
    );
  }
  await User.updateMany(
    { discoverable: { $exists: false } },
    { $set: { discoverable: true } }
  );
  await User.updateMany(
    { allow_friend_requests: { $exists: false } },
    { $set: { allow_friend_requests: true } }
  );
  console.log(`✅ Added unique handles to ${users.length} existing account(s)`);
}

async function ensureIndexes() {
  try {
    await ensureLegacyUsernameKeys();
    await Promise.all([
      User.createIndexes(),
      Movie.createIndexes(),
      Series.createIndexes(),
      Friendship.createIndexes(),
      FriendRequest.createIndexes(),
      FriendPermission.createIndexes(),
      Block.createIndexes(),
      InviteCode.createIndexes(),
    ]);
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

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  normalizeUsername,
  sanitizeLegacyUsername,
  socialPairKey,
  cleanPermissions,
  hashInviteCode,
};
