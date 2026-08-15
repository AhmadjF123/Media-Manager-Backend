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

const TMDB_API_KEY =
  process.env.TMDB_API_KEY ||
  "001a45ee2ffa1d6f2f16fc4c16ae276a";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_W500 = "https://image.tmdb.org/t/p/w500";

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
  tmdb_id: { type: Number, min: 1, default: null },
  tmdb_relation_keywords: {
    type: [{ _id: false, id: { type: Number }, name: { type: String, trim: true } }],
    default: [],
  },
  tmdb_collection_id: { type: Number, default: null },
  tmdb_collection_name: { type: String, default: null },
  tmdb_relation_scanned_at: { type: Date, default: null },
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
  schema.index({ user_id: 1, tmdb_id: 1 }, { name: "user_tmdb_idx" });

  return schema;
}

const movieSchema = createMediaSchema();
const seriesSchema = createMediaSchema({
  end_year: { type: Number, default: null },
  number_of_seasons: { type: Number, min: 1, default: null },
  watched_seasons: { type: Number, min: 0, default: null },
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
    scope: {
      type: String,
      enum: ["filters", "all", "selected", "all_except", "none"],
      default: "filters",
    },
    selected_items: { type: [String], default: [] },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" }, versionKey: false }
);
friendPermissionSchema.index(
  { owner_id: 1, viewer_id: 1 },
  { unique: true, name: "owner_viewer_permission_idx" }
);

const globalShareSettingSchema = new mongoose.Schema(
  {
    owner_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    watching: { type: Boolean, default: true },
    watched: { type: Boolean, default: true },
    favorites: { type: Boolean, default: true },
    ratings: { type: Boolean, default: true },
    full_collection: { type: Boolean, default: false },
    scope: {
      type: String,
      enum: ["filters", "all", "selected", "all_except", "none"],
      default: "filters",
    },
    selected_items: { type: [String], default: [] },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" }, versionKey: false }
);
globalShareSettingSchema.index({ owner_id: 1 }, { unique: true, name: "global_share_owner_idx" });

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
const GlobalShareSetting = mongoose.model("GlobalShareSetting", globalShareSettingSchema);
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
  scope: "filters",
  selected_items: [],
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
  const allowedScopes = new Set(["filters", "all", "selected", "all_except", "none"]);
  let scope = allowedScopes.has(input.scope) ? input.scope : (input.full_collection ? "all" : "filters");
  const selected_items = Array.from(new Set(
    (Array.isArray(input.selected_items) ? input.selected_items : [])
      .map((value) => String(value || "").trim())
      .filter((value) => /^(movie|series):(?:[a-f0-9]{24}|order:\d+)$/i.test(value))
  )).slice(0, 5000);
  const full_collection = scope === "all";
  return {
    watching: Boolean(input.watching),
    watched: Boolean(input.watched),
    favorites: Boolean(input.favorites),
    ratings: Boolean(input.ratings),
    full_collection,
    scope,
    selected_items,
  };
}

async function getGlobalSharing(ownerId) {
  const doc = await GlobalShareSetting.findOne({ owner_id: ownerId }).lean();
  return doc ? cleanPermissions(doc) : { ...DEFAULT_SHARING, selected_items: [] };
}

function parseSelectedItems(values = []) {
  const parsed = {
    movieIds: [], seriesIds: [], movieOrders: [], seriesOrders: [], tokenSet: new Set(),
  };
  for (const raw of values) {
    const token = String(raw || "").trim();
    const match = token.match(/^(movie|series):(.+)$/i);
    if (!match) continue;
    const type = match[1].toLowerCase();
    const value = match[2];
    parsed.tokenSet.add(`${type}:${value}`);
    if (/^[a-f0-9]{24}$/i.test(value)) parsed[type === "movie" ? "movieIds" : "seriesIds"].push(value);
    else if (/^order:\d+$/i.test(value)) parsed[type === "movie" ? "movieOrders" : "seriesOrders"].push(Number(value.slice(6)));
  }
  return parsed;
}

function buildSelectedFilter(userId, type, selected, include) {
  const ids = selected[type === "movie" ? "movieIds" : "seriesIds"];
  const orders = selected[type === "movie" ? "movieOrders" : "seriesOrders"];
  const filter = { user_id: userId };
  if (include) {
    const clauses = [];
    if (ids.length) clauses.push({ _id: { $in: ids } });
    if (orders.length) clauses.push({ order_number: { $in: orders } });
    if (!clauses.length) return null;
    filter.$or = clauses;
  } else {
    if (ids.length) filter._id = { $nin: ids };
    if (orders.length) filter.order_number = { $nin: orders };
  }
  return filter;
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

// ==================== Personalized recommendation engine ====================
// The engine runs on the backend so the website and any future mobile client can
// share the same ranking logic. TMDB responses are cached aggressively to keep
// refreshes fast and to avoid unnecessary third-party requests.

const RECOMMENDATION_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.RECOMMENDATION_CACHE_TTL_MS) || 20 * 60_000
);
const TMDB_CACHE_TTL_MS = Math.max(
  5 * 60_000,
  Number(process.env.TMDB_CACHE_TTL_MS) || 6 * 60 * 60_000
);
const recommendationCache = new Map();
const tmdbResponseCache = new Map();
let genreNameMapsPromise = null;

function recommendationCacheKey(userId) {
  return `v3:${String(userId)}`;
}

function invalidateUserRecommendationCache(userId) {
  recommendationCache.delete(recommendationCacheKey(userId));
}

function getCachedRecommendation(userId) {
  const key = recommendationCacheKey(userId);
  const entry = recommendationCache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    recommendationCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedRecommendation(userId, value) {
  recommendationCache.set(recommendationCacheKey(userId), {
    value,
    expiresAt: Date.now() + RECOMMENDATION_CACHE_TTL_MS,
  });
  while (recommendationCache.size > 500) {
    recommendationCache.delete(recommendationCache.keys().next().value);
  }
}

function cleanTitleKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function yearFromDate(value) {
  const match = String(value || "").match(/^(\d{4})/);
  return match ? Number(match[1]) : 0;
}

function isReleasedByToday(dateValue) {
  if (!dateValue) return true;
  const parsed = new Date(`${String(dateValue).slice(0, 10)}T00:00:00Z`).getTime();
  return !Number.isFinite(parsed) || parsed <= Date.now();
}

function itemCountsAsWatched(item) {
  if (item.watch_status === "watched") return true;
  if (["watching", "plan_to_watch", "dropped"].includes(item.watch_status)) return false;
  // Legacy collections existed before watch-status tracking. Those saved titles
  // represented watched media, so preserving that assumption keeps old accounts useful.
  return true;
}

function itemCountsAsUnwatched(item) {
  return ["watching", "plan_to_watch"].includes(item.watch_status);
}

function effectiveWatchedSeasons(item) {
  const savedSeasons = Math.max(0, Number(item?.number_of_seasons) || 0);
  const hasTrackedValue =
    item?.watched_seasons !== null &&
    item?.watched_seasons !== undefined &&
    item?.watched_seasons !== "" &&
    Number.isFinite(Number(item.watched_seasons));
  const tracked = hasTrackedValue ? Math.max(0, Number(item.watched_seasons)) : null;

  // `watched` means the user finished every season that was saved in the vault at
  // that moment. Older accounts had no progress field at all, and a few early
  // clients wrote 0 while still treating the title as fully watched. In both cases
  // the saved season count is the safest completion baseline.
  if (item?.watch_status === "watched") {
    return Math.max(savedSeasons, tracked ?? 0);
  }

  // Legacy titles predate watch-status tracking and historically represented
  // already-watched media. Only a positive explicit progress value should override
  // that legacy baseline. This prevents finished shows from being presented as 0/N.
  if (!item?.watch_status) {
    if (tracked !== null && tracked > 0) return tracked;
    return savedSeasons;
  }

  // Watching / plan-to-watch / dropped titles use the explicit progress value.
  return tracked ?? 0;
}

function getSourceStrength(item) {
  let score = 16;
  if (item.favorite) score += 10;
  const rating = Number(item.rating) || 0;
  score += Math.max(0, rating - 5) * 2.4;
  if (item.watch_status === "watched") score += 4;
  if (item.rewatch_count > 0) score += Math.min(8, Number(item.rewatch_count) * 2);

  const activityDate = item.watch_date || item.updated_at || item.created_at;
  const activityTime = activityDate ? new Date(activityDate).getTime() : 0;
  if (Number.isFinite(activityTime) && activityTime > 0) {
    const ageDays = Math.max(0, (Date.now() - activityTime) / 86_400_000);
    if (ageDays <= 30) score += 8;
    else if (ageDays <= 90) score += 5;
    else if (ageDays <= 180) score += 2;
  }
  return score;
}

async function tmdbGet(path, params = {}, { ttl = TMDB_CACHE_TTL_MS } = {}) {
  if (!TMDB_API_KEY) throw new Error("TMDB_API_KEY is not configured");
  const url = new URL(`${TMDB_BASE_URL}${path}`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", "en-US");
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const cacheKey = url.toString();
  const cached = tmdbResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) tmdbResponseCache.delete(cacheKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  timeout.unref?.();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`TMDB request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    const value = await response.json();
    tmdbResponseCache.set(cacheKey, { value, expiresAt: Date.now() + ttl });
    if (tmdbResponseCache.size > 1_500) {
      tmdbResponseCache.delete(tmdbResponseCache.keys().next().value);
    }
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        results[index] = { __error: error };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, () => worker())
  );
  return results;
}

async function getGenreNameMaps() {
  if (!genreNameMapsPromise) {
    genreNameMapsPromise = Promise.all([
      tmdbGet("/genre/movie/list", {}, { ttl: 24 * 60 * 60_000 }),
      tmdbGet("/genre/tv/list", {}, { ttl: 24 * 60 * 60_000 }),
    ]).then(([movieData, tvData]) => ({
      movie: new Map((movieData.genres || []).map((genre) => [Number(genre.id), genre.name])),
      series: new Map((tvData.genres || []).map((genre) => [Number(genre.id), genre.name])),
    })).catch((error) => {
      genreNameMapsPromise = null;
      throw error;
    });
  }
  return genreNameMapsPromise;
}

function chooseTmdbSearchResult(results, item, type) {
  const titleKey = cleanTitleKey(item.title);
  const targetYear = Number(item.release_year) || 0;
  let best = null;
  let bestScore = -Infinity;
  for (const result of (results || []).slice(0, 12)) {
    const candidateTitle = type === "movie"
      ? (result.title || result.original_title)
      : (result.name || result.original_name);
    const candidateYear = yearFromDate(
      type === "movie" ? result.release_date : result.first_air_date
    );
    let score = 0;
    if (cleanTitleKey(candidateTitle) === titleKey) score += 80;
    else if (cleanTitleKey(candidateTitle).includes(titleKey) || titleKey.includes(cleanTitleKey(candidateTitle))) {
      score += 35;
    }
    if (targetYear && candidateYear) {
      const diff = Math.abs(targetYear - candidateYear);
      score += diff === 0 ? 30 : diff === 1 ? 14 : Math.max(0, 8 - diff * 2);
    }
    score += Math.min(12, Number(result.popularity) / 10 || 0);
    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }
  return best;
}

async function resolveMediaTmdb(item, type) {
  const existingId = Number(item.tmdb_id);
  if (Number.isInteger(existingId) && existingId > 0) return existingId;

  const endpoint = type === "movie" ? "/search/movie" : "/search/tv";
  const params = { query: item.title, include_adult: "false" };
  if (item.release_year) {
    params[type === "movie" ? "primary_release_year" : "first_air_date_year"] = item.release_year;
  }

  let data = await tmdbGet(endpoint, params);
  let match = chooseTmdbSearchResult(data.results, item, type);
  if (!match && item.release_year) {
    data = await tmdbGet(endpoint, { query: item.title, include_adult: "false" });
    match = chooseTmdbSearchResult(data.results, item, type);
  }
  const id = Number(match?.id) || 0;
  if (id > 0 && item._id) {
    const Model = type === "movie" ? Movie : Series;
    Model.updateOne(
      { _id: item._id, user_id: item.user_id },
      { $set: { tmdb_id: id } }
    ).catch(() => {});
    item.tmdb_id = id;
  }
  return id;
}


const RELATION_SCAN_MAX_AGE_MS = Math.max(
  24 * 60 * 60_000,
  Number(process.env.RELATION_SCAN_MAX_AGE_MS) || 30 * 24 * 60 * 60_000
);
const RELATION_SYNC_SCAN_LIMIT = Math.max(
  24,
  Math.min(160, Number(process.env.RELATION_SYNC_SCAN_LIMIT) || 96)
);
const relationshipEnrichmentJobs = new Set();

function relationMetadataIsFresh(item) {
  if (!item?.tmdb_relation_scanned_at) return false;
  const scannedAt = new Date(item.tmdb_relation_scanned_at).getTime();
  return Number.isFinite(scannedAt) && (Date.now() - scannedAt) < RELATION_SCAN_MAX_AGE_MS;
}

function relationKeywordList(details) {
  const raw = details?.keywords?.keywords || details?.keywords?.results || [];
  return raw
    .map((keyword) => ({ id: Number(keyword?.id) || 0, name: String(keyword?.name || "").trim() }))
    .filter((keyword) => keyword.id > 0 && keyword.name)
    .slice(0, 60);
}

function relationScanPriority(item) {
  let score = getSourceStrength(item);
  if (Number(item?.tmdb_id) > 0) score += 40;
  const genre = String(item?.genre || "").toLowerCase();
  if (/action|adventure|science fiction|sci-fi|fantasy|superhero|animation/.test(genre)) score += 22;
  if (item?.favorite) score += 12;
  return score;
}

async function enrichRelationMetadata(item, { force = false } = {}) {
  if (!item || (!force && relationMetadataIsFresh(item))) return item;
  const mediaType = item.media_type === "series" ? "series" : "movie";
  const tmdbType = mediaType === "series" ? "tv" : "movie";
  const Model = mediaType === "series" ? Series : Movie;
  const tmdbId = await resolveMediaTmdb(item, mediaType);
  if (!tmdbId) return item;

  const details = await tmdbGet(`/${tmdbType}/${tmdbId}`, { append_to_response: "keywords" });
  const keywords = relationKeywordList(details);
  const collectionId = mediaType === "movie" ? Number(details?.belongs_to_collection?.id) || null : null;
  const collectionName = mediaType === "movie"
    ? String(details?.belongs_to_collection?.name || "").trim() || null
    : null;
  const scannedAt = new Date();

  item.tmdb_id = tmdbId;
  item.tmdb_relation_keywords = keywords;
  item.tmdb_collection_id = collectionId;
  item.tmdb_collection_name = collectionName;
  item.tmdb_relation_scanned_at = scannedAt;

  if (item._id) {
    await Model.updateOne(
      { _id: item._id, user_id: item.user_id },
      {
        $set: {
          tmdb_id: tmdbId,
          tmdb_relation_keywords: keywords,
          tmdb_collection_id: collectionId,
          tmdb_collection_name: collectionName,
          tmdb_relation_scanned_at: scannedAt,
        },
      }
    ).catch(() => {});
  }
  return item;
}

function queueFullRelationshipEnrichment(userId, watchedItems) {
  const key = String(userId);
  if (relationshipEnrichmentJobs.has(key)) return;
  const pending = (watchedItems || [])
    .filter((item) => !relationMetadataIsFresh(item))
    .sort((a, b) => relationScanPriority(b) - relationScanPriority(a));
  if (!pending.length) return;

  relationshipEnrichmentJobs.add(key);
  setImmediate(async () => {
    try {
      // Keep this deliberately gentle: the foreground request gets a fast priority
      // pass, while the remaining library is progressively indexed in MongoDB.
      for (let i = 0; i < pending.length; i += 6) {
        const chunk = pending.slice(i, i + 6);
        await Promise.allSettled(chunk.map((item) => enrichRelationMetadata(item)));
      }
      invalidateUserRecommendationCache(userId);
    } finally {
      relationshipEnrichmentJobs.delete(key);
    }
  });
}

const GENERIC_RELATION_KEYWORDS = new Set([
  "based on comic", "superhero", "sequel", "prequel", "spin off", "spin-off",
  "family", "friendship", "murder", "police", "detective", "crime", "revenge",
  "love", "romance", "violence", "death", "based on novel", "based on true story",
  "woman director", "duringcreditsstinger", "aftercreditsstinger", "post credit scene",
  "secret identity", "super power", "super powers", "hero", "villain", "future",
  "space", "alien", "magic", "war", "new york city", "los angeles, california"
]);

function normalizeRelationKeywordName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isStrongUniverseKeyword(name, count) {
  const normalized = normalizeRelationKeywordName(name);
  if (!normalized || GENERIC_RELATION_KEYWORDS.has(normalized)) return false;
  if (/cinematic universe|shared universe|universe \(|\buniverse\b|\bsaga\b|\bfranchise\b/.test(normalized)) return true;
  if (/\bmarvel\b|\bdc\b|star wars|wizarding world|middle earth|middle-earth|star trek|transformers|james bond|mission impossible|planet of the apes/.test(normalized)) return true;
  // A keyword recurring across many different watched titles is often a real world/
  // franchise tag. Requiring four occurrences prevents generic one-off themes from
  // becoming universe recommendations.
  return count >= 4 && normalized.length >= 7 && normalized.split(" ").length <= 5;
}

function collectUniverseKeywordSignals(watchedItems) {
  const keywordMap = new Map();
  for (const item of watchedItems || []) {
    for (const keyword of item.tmdb_relation_keywords || []) {
      const id = Number(keyword?.id) || 0;
      const name = String(keyword?.name || "").trim();
      if (!id || !name) continue;
      const entry = keywordMap.get(id) || { id, name, count: 0, source_titles: [] };
      entry.count += 1;
      if (item.title && entry.source_titles.length < 6 && !entry.source_titles.includes(item.title)) {
        entry.source_titles.push(item.title);
      }
      keywordMap.set(id, entry);
    }
  }

  return Array.from(keywordMap.values())
    .filter((entry) => entry.count >= 2 && isStrongUniverseKeyword(entry.name, entry.count))
    .map((entry) => {
      const normalized = normalizeRelationKeywordName(entry.name);
      const semanticBoost = /cinematic universe|shared universe|\buniverse\b/.test(normalized) ? 90
        : /\bsaga\b|\bfranchise\b/.test(normalized) ? 55
          : 25;
      return { ...entry, signal_score: semanticBoost + Math.min(80, entry.count * 8) };
    })
    .sort((a, b) => b.signal_score - a.signal_score || b.count - a.count)
    .slice(0, 24);
}

async function addUniverseDiscoverCandidates(candidateMap, signals) {
  if (!Array.isArray(signals) || !signals.length) return;
  const today = new Date().toISOString().slice(0, 10);

  await mapWithConcurrency(signals, 4, async (signal) => {
    const common = {
      with_keywords: signal.id,
      include_adult: "false",
      page: 1,
    };
    const [movieResult, tvResult] = await Promise.allSettled([
      tmdbGet("/discover/movie", {
        ...common,
        sort_by: "primary_release_date.desc",
        "primary_release_date.lte": today,
      }),
      tmdbGet("/discover/tv", {
        ...common,
        sort_by: "first_air_date.desc",
        "first_air_date.lte": today,
      }),
    ]);

    const reason = `Connected to ${signal.name}`;
    const sourceTitle = signal.source_titles?.[0] || "Your watch history";
    const baseScore = 118 + Math.min(90, Number(signal.signal_score) || 0);

    if (movieResult.status === "fulfilled") {
      for (const [index, rec] of (movieResult.value.results || []).slice(0, 20).entries()) {
        addCandidate(candidateMap, rec, "movie", {
          score: baseScore - index * 0.7,
          reason,
          reasonType: "same_universe",
          sourceTitle,
        });
      }
    }
    if (tvResult.status === "fulfilled") {
      for (const [index, rec] of (tvResult.value.results || []).slice(0, 20).entries()) {
        addCandidate(candidateMap, rec, "series", {
          score: baseScore - index * 0.7,
          reason,
          reasonType: "same_universe",
          sourceTitle,
        });
      }
    }
  });
}

async function addAllKnownCollectionContinuations(candidateMap, watchedItems) {
  const collections = new Map();
  for (const item of watchedItems || []) {
    const id = Number(item.tmdb_collection_id) || 0;
    if (!id) continue;
    const entry = collections.get(id) || {
      id,
      name: item.tmdb_collection_name || "this film series",
      source_titles: [],
      strength: 0,
    };
    entry.strength += getSourceStrength(item);
    if (item.title && entry.source_titles.length < 5 && !entry.source_titles.includes(item.title)) {
      entry.source_titles.push(item.title);
    }
    collections.set(id, entry);
  }

  await mapWithConcurrency(Array.from(collections.values()), 5, async (collectionSignal) => {
    const collection = await tmdbGet(`/collection/${collectionSignal.id}`);
    const releasedParts = (collection.parts || [])
      .filter((part) => isReleasedByToday(part.release_date))
      .sort((a, b) => String(a.release_date || "").localeCompare(String(b.release_date || "")));
    for (const [index, part] of releasedParts.entries()) {
      addCandidate(candidateMap, part, "movie", {
        score: 138 + Math.min(55, collectionSignal.strength / 4) - index * 0.2,
        reason: `From ${collection.name || collectionSignal.name}`,
        reasonType: "franchise_next",
        sourceTitle: collectionSignal.source_titles[0] || "Your watch history",
      });
    }
  });
}

function getAiredSeasons(details) {
  const today = new Date().toISOString().slice(0, 10);
  return (details?.seasons || [])
    .filter((season) =>
      Number(season.season_number) > 0 &&
      Number(season.episode_count) > 0 &&
      Boolean(season.air_date) &&
      String(season.air_date) <= today
    )
    .sort((a, b) => Number(a.season_number) - Number(b.season_number));
}

function recommendationPoster(path) {
  return path ? `${TMDB_IMAGE_W500}${path}` : null;
}

function candidateFromTmdb(raw, mediaType) {
  const date = mediaType === "movie" ? raw.release_date : raw.first_air_date;
  return {
    tmdb_id: Number(raw.id) || null,
    media_type: mediaType,
    title: mediaType === "movie"
      ? (raw.title || raw.original_title || "Untitled")
      : (raw.name || raw.original_name || "Untitled"),
    release_date: date || null,
    release_year: yearFromDate(date),
    poster_url: recommendationPoster(raw.poster_path),
    backdrop_url: raw.backdrop_path
      ? `https://image.tmdb.org/t/p/w780${raw.backdrop_path}`
      : null,
    tmdb_rating: Number(raw.vote_average) || 0,
    popularity: Number(raw.popularity) || 0,
    overview: String(raw.overview || "").trim(),
    genre_ids: Array.isArray(raw.genre_ids)
      ? raw.genre_ids.map(Number).filter(Number.isFinite)
      : (Array.isArray(raw.genres) ? raw.genres.map((genre) => Number(genre.id)).filter(Number.isFinite) : []),
  };
}

function addCandidate(candidateMap, raw, mediaType, {
  score = 0,
  reason = "",
  reasonType = "related",
  sourceTitle = "",
  progress = null,
} = {}) {
  if (!raw?.id || raw.adult === true) return;
  const base = candidateFromTmdb(raw, mediaType);
  if (!isReleasedByToday(base.release_date) && reasonType !== "upcoming") return;
  const key = `${mediaType}:${base.tmdb_id}`;
  const current = candidateMap.get(key) || {
    ...base,
    score: 0,
    reasons: [],
    reason_types: [],
    source_titles: [],
    progress: null,
  };

  current.score += Number(score) || 0;
  if (reason && !current.reasons.includes(reason)) current.reasons.push(reason);
  if (reasonType && !current.reason_types.includes(reasonType)) current.reason_types.push(reasonType);
  if (sourceTitle && !current.source_titles.includes(sourceTitle)) current.source_titles.push(sourceTitle);
  if (progress) current.progress = progress;

  // Keep the best available metadata if a duplicate came from another source.
  if (!current.poster_url && base.poster_url) current.poster_url = base.poster_url;
  if (!current.backdrop_url && base.backdrop_url) current.backdrop_url = base.backdrop_url;
  if (!current.overview && base.overview) current.overview = base.overview;
  current.tmdb_rating = Math.max(current.tmdb_rating || 0, base.tmdb_rating || 0);
  current.popularity = Math.max(current.popularity || 0, base.popularity || 0);

  candidateMap.set(key, current);
}

async function fetchTvRecommendations(tvId) {
  try {
    return await tmdbGet(`/tv/${tvId}/recommendations`, { page: 1 });
  } catch (error) {
    // Older/future TMDB deployments can still provide "similar"; keep the engine useful.
    return tmdbGet(`/tv/${tvId}/similar`, { page: 1 });
  }
}

function makeVaultLookup(movies, series) {
  const byTmdb = new Map();
  const byTitleYear = new Map();
  for (const [type, items] of [["movie", movies], ["series", series]]) {
    for (const item of items) {
      if (Number(item.tmdb_id) > 0) byTmdb.set(`${type}:${Number(item.tmdb_id)}`, item);
      byTitleYear.set(
        `${type}:${cleanTitleKey(item.title)}:${Number(item.release_year) || 0}`,
        item
      );
    }
  }
  return {
    find(candidate) {
      return byTmdb.get(`${candidate.media_type}:${candidate.tmdb_id}`) ||
        byTitleYear.get(
          `${candidate.media_type}:${cleanTitleKey(candidate.title)}:${Number(candidate.release_year) || 0}`
        ) ||
        null;
    },
  };
}

function sortRecommendationItems(items) {
  return items.sort((a, b) => {
    const scoreDiff = (Number(b.score) || 0) - (Number(a.score) || 0);
    if (scoreDiff) return scoreDiff;
    const dateDiff = String(b.release_date || "").localeCompare(String(a.release_date || ""));
    if (dateDiff) return dateDiff;
    return (Number(b.tmdb_rating) || 0) - (Number(a.tmdb_rating) || 0);
  });
}

function trimRecommendation(item) {
  const score = Math.max(1, Number(item.score) || 1);
  // A recommendation score is a ranking signal, not a probability. Keep the
  // display value useful instead of saturating nearly every strong pick at 99%.
  const displayMatch = Math.round(60 + 36 * (1 - Math.exp(-score / 105)));
  return {
    ...item,
    score: Math.round(score),
    match_score: Math.min(96, Math.max(60, displayMatch)),
    reasons: item.reasons.slice(0, 3),
    source_titles: item.source_titles.slice(0, 4),
  };
}

async function buildRecommendationPayload(userId) {
  const [movies, series, genreMaps] = await Promise.all([
    Movie.find({ user_id: userId })
      .select("_id user_id title genre release_year rating tmdb_id tmdb_relation_keywords tmdb_collection_id tmdb_collection_name tmdb_relation_scanned_at watch_status watch_date favorite rewatch_count order_number created_at updated_at")
      .lean(),
    Series.find({ user_id: userId })
      .select("_id user_id title genre release_year rating tmdb_id tmdb_relation_keywords tmdb_collection_id tmdb_collection_name tmdb_relation_scanned_at watch_status watch_date favorite rewatch_count order_number number_of_seasons watched_seasons created_at updated_at")
      .lean(),
    getGenreNameMaps().catch(() => ({ movie: new Map(), series: new Map() })),
  ]);

  const allItems = [
    ...movies.map((item) => ({ ...item, media_type: "movie" })),
    ...series.map((item) => ({ ...item, media_type: "series" })),
  ];
  const watchedItems = allItems
    .filter(itemCountsAsWatched)
    .sort((a, b) => getSourceStrength(b) - getSourceStrength(a));

  const candidateMap = new Map();

  // Relationship coverage deliberately looks beyond the small taste-anchor budget.
  // We synchronously enrich the highest-value missing records so the first request can
  // discover major universes immediately, then progressively index EVERY remaining
  // watched title in the background and persist the graph metadata in MongoDB.
  const missingRelationMetadata = watchedItems
    .filter((item) => !relationMetadataIsFresh(item))
    .sort((a, b) => relationScanPriority(b) - relationScanPriority(a));
  await mapWithConcurrency(
    missingRelationMetadata.slice(0, RELATION_SYNC_SCAN_LIMIT),
    8,
    async (item) => enrichRelationMetadata(item)
  );
  queueFullRelationshipEnrichment(userId, watchedItems);

  const universeSignals = collectUniverseKeywordSignals(watchedItems);
  await Promise.all([
    addUniverseDiscoverCandidates(candidateMap, universeSignals),
    addAllKnownCollectionContinuations(candidateMap, watchedItems),
  ]);

  // Series progress is checked across the whole watched/watching series history, not
  // only the handful of titles used as taste anchors. This is what lets the engine
  // notice a newly aired season even for an older show.
  const progressSeries = allItems.filter((item) =>
    item.media_type === "series" &&
    (itemCountsAsWatched(item) || item.watch_status === "watching")
  );
  await mapWithConcurrency(progressSeries, 5, async (item) => {
    item.tmdb_id = await resolveMediaTmdb(item, "series");
    return item;
  });
  await mapWithConcurrency(progressSeries.filter((item) => Number(item.tmdb_id) > 0), 5, async (item) => {
    const details = await tmdbGet(`/tv/${Number(item.tmdb_id)}`);
    const airedSeasons = getAiredSeasons(details);
    const totalAired = airedSeasons.length;
    let watchedThrough = effectiveWatchedSeasons(item);

    // Some long-standing collections predate both season-count and progress fields.
    // Those entries already mean "I watched this title". On the first smart scan,
    // establish today's aired-season count as their baseline instead of telling the
    // user to start a finished show from Season 1. Persisting that baseline is what
    // lets a genuinely NEW season be detected later.
    const hasSavedSeasonBaseline = Math.max(0, Number(item.number_of_seasons) || 0) > 0;
    const hasTrackedSeasonBaseline =
      item.watched_seasons !== null &&
      item.watched_seasons !== undefined &&
      item.watched_seasons !== "" &&
      Math.max(0, Number(item.watched_seasons) || 0) > 0;
    if (
      totalAired > 0 &&
      itemCountsAsWatched(item) &&
      !hasSavedSeasonBaseline &&
      !hasTrackedSeasonBaseline
    ) {
      watchedThrough = totalAired;
      Series.updateOne(
        { _id: item._id, user_id: item.user_id },
        { $set: { watched_seasons: totalAired } }
      ).catch(() => {});
    }

    if (totalAired <= watchedThrough) return;

    const nextSeasonNumber = airedSeasons
      .map((season) => Number(season.season_number))
      .find((seasonNumber) => seasonNumber > watchedThrough) || watchedThrough + 1;
    addCandidate(candidateMap, details, "series", {
      score: 190 + getSourceStrength(item) + Math.min(20, (totalAired - watchedThrough) * 4),
      reason: totalAired - watchedThrough === 1
        ? `Season ${nextSeasonNumber} is ready for you`
        : `${totalAired - watchedThrough} newer seasons are available`,
      reasonType: "new_season",
      sourceTitle: item.title,
      progress: {
        watched_seasons: watchedThrough,
        aired_seasons: totalAired,
        next_season: nextSeasonNumber,
        latest_aired_season: Number(airedSeasons.at(-1)?.season_number) || totalAired,
      },
    });
  });

  // Keep taste anchors balanced across movies and series. Without this, a user with
  // many highly-rated shows could spend the entire source budget on TV and the For You
  // feed would look series-only even when their movie history is substantial.
  const movieAnchors = watchedItems.filter((item) => item.media_type === "movie").slice(0, 6);
  const seriesAnchors = watchedItems.filter((item) => item.media_type === "series").slice(0, 6);
  const balancedAnchorKeys = new Set(
    [...movieAnchors, ...seriesAnchors].map((item) => `${item.media_type}:${String(item._id || item.title)}`)
  );
  const sourceItems = [...movieAnchors, ...seriesAnchors];
  for (const item of watchedItems) {
    if (sourceItems.length >= 12) break;
    const key = `${item.media_type}:${String(item._id || item.title)}`;
    if (balancedAnchorKeys.has(key)) continue;
    balancedAnchorKeys.add(key);
    sourceItems.push(item);
  }
  sourceItems.sort((a, b) => getSourceStrength(b) - getSourceStrength(a));
  await mapWithConcurrency(sourceItems, 4, async (item) => {
    item.tmdb_id = await resolveMediaTmdb(item, item.media_type);
    return item;
  });

  await mapWithConcurrency(sourceItems, 4, async (item) => {
    const tmdbId = Number(item.tmdb_id);
    if (!tmdbId) return;
    const type = item.media_type;
    const sourceStrength = getSourceStrength(item);

    if (type === "movie") {
      const [detailsResult, recommendationsResult] = await Promise.allSettled([
        tmdbGet(`/movie/${tmdbId}`),
        tmdbGet(`/movie/${tmdbId}/recommendations`, { page: 1 }),
      ]);
      const details = detailsResult.status === "fulfilled" ? detailsResult.value : null;
      const recommendations = recommendationsResult.status === "fulfilled"
        ? recommendationsResult.value.results || []
        : [];

      for (const rec of recommendations.slice(0, 12)) {
        addCandidate(candidateMap, rec, "movie", {
          score: sourceStrength + 18 + Math.min(10, Number(rec.vote_average) || 0),
          reason: `Because you watched ${item.title}`,
          reasonType: "because_watched",
          sourceTitle: item.title,
        });
      }

      const collectionId = Number(details?.belongs_to_collection?.id);
      if (collectionId) {
        try {
          const collection = await tmdbGet(`/collection/${collectionId}`);
          const releasedParts = (collection.parts || [])
            .filter((part) => isReleasedByToday(part.release_date))
            .sort((a, b) => String(a.release_date || "").localeCompare(String(b.release_date || "")));
          const sourceIndex = releasedParts.findIndex((part) => Number(part.id) === tmdbId);
          const following = releasedParts.filter((part, index) =>
            Number(part.id) !== tmdbId && (sourceIndex < 0 || index > sourceIndex)
          );
          for (const [offset, part] of following.slice(0, 4).entries()) {
            addCandidate(candidateMap, part, "movie", {
              score: 145 - offset * 12 + sourceStrength,
              reason: `Next in ${collection.name || "this film series"}`,
              reasonType: "franchise_next",
              sourceTitle: item.title,
            });
          }
        } catch {
          // Recommendation results below still provide useful suggestions.
        }
      }
      return;
    }

    const recommendationsResult = await Promise.allSettled([
      fetchTvRecommendations(tmdbId),
    ]);
    const recommendations = recommendationsResult[0]?.status === "fulfilled"
      ? recommendationsResult[0].value.results || []
      : [];

    for (const rec of recommendations.slice(0, 12)) {
      addCandidate(candidateMap, rec, "series", {
        score: sourceStrength + 20 + Math.min(10, Number(rec.vote_average) || 0),
        reason: `Because you watched ${item.title}`,
        reasonType: "because_watched",
        sourceTitle: item.title,
      });
    }

  });

  const vaultLookup = makeVaultLookup(movies, series);
  const now = Date.now();
  const recentCutoff = new Date(now);
  recentCutoff.setMonth(recentCutoff.getMonth() - 24);

  const allCandidates = [];
  for (const candidate of candidateMap.values()) {
    const vaultItem = vaultLookup.find(candidate);
    const isNewSeasonSelf = candidate.reason_types.includes("new_season");
    const vaultWatched = vaultItem ? itemCountsAsWatched(vaultItem) : false;
    if (vaultItem?.watch_status === "dropped") continue;
    if (vaultItem && vaultWatched && !isNewSeasonSelf) continue;

    if (vaultItem) {
      candidate.in_vault = true;
      candidate.vault_order_number = Number(vaultItem.order_number) || null;
      candidate.vault_watch_status = vaultItem.watch_status || null;
      candidate.vault_rating = Number(vaultItem.rating) || 0;
      candidate.score += itemCountsAsUnwatched(vaultItem) ? 42 : 22;
      if (!candidate.poster_url && vaultItem.poster_url) candidate.poster_url = vaultItem.poster_url;
    } else {
      candidate.in_vault = false;
      candidate.vault_order_number = null;
      candidate.vault_watch_status = null;
      candidate.vault_rating = null;
    }

    const genreMap = genreMaps[candidate.media_type] || new Map();
    candidate.genres = candidate.genre_ids
      .map((id) => genreMap.get(Number(id)))
      .filter(Boolean)
      .slice(0, 4);

    const releaseTime = candidate.release_date
      ? new Date(`${candidate.release_date}T00:00:00Z`).getTime()
      : 0;
    candidate.is_recent_release = Boolean(
      releaseTime && releaseTime >= recentCutoff.getTime() && releaseTime <= now
    );

    candidate.primary_reason = candidate.reasons[0] || "Picked from your watch history";
    candidate.primary_reason_type = candidate.reason_types[0] || "related";
    allCandidates.push(trimRecommendation(candidate));
  }

  const claimed = new Set();
  const take = (predicate, limit, sortFn = sortRecommendationItems) => {
    const selected = allCandidates
      .filter((item) => !claimed.has(`${item.media_type}:${item.tmdb_id}`) && predicate(item));
    sortFn(selected);
    const sliced = selected.slice(0, limit);
    for (const item of sliced) claimed.add(`${item.media_type}:${item.tmdb_id}`);
    return sliced;
  };

  const continueStory = take(
    (item) => item.reason_types.includes("new_season") || item.reason_types.includes("franchise_next"),
    60
  );
  const fromVault = take((item) => item.in_vault, 80);
  const connectedUniverses = take(
    (item) => item.reason_types.includes("same_universe"),
    100
  );
  const newReleases = take(
    (item) => !item.in_vault && item.is_recent_release,
    60,
    (items) => items.sort((a, b) => {
      const yearDiff = (Number(b.release_year) || 0) - (Number(a.release_year) || 0);
      if (yearDiff) return yearDiff;
      const dateDiff = String(b.release_date || "").localeCompare(String(a.release_date || ""));
      return dateDiff || (Number(b.score) || 0) - (Number(a.score) || 0);
    })
  );
  const becauseYouWatched = take((item) => !item.in_vault, 100);

  return {
    generated_at: new Date().toISOString(),
    profile: {
      vault_total: allItems.length,
      watched_count: watchedItems.length,
      movies_watched: watchedItems.filter((item) => item.media_type === "movie").length,
      series_watched: watchedItems.filter((item) => item.media_type === "series").length,
      tracked_series_progress: progressSeries.length,
    },
    sections: {
      continue_story: continueStory,
      from_vault: fromVault,
      connected_universes: connectedUniverses,
      new_releases: newReleases,
      because_you_watched: becauseYouWatched,
    },
    meta: {
      recommendation_version: 3,
      cached_for_ms: RECOMMENDATION_CACHE_TTL_MS,
      source_titles_used: sourceItems.length,
      relationship_titles_indexed: watchedItems.filter((item) => relationMetadataIsFresh(item)).length,
      relationship_titles_total: watchedItems.length,
      universe_signals_found: universeSignals.length,
    },
  };
}

// ==================== Middleware ====================

app.disable("x-powered-by");
app.set("etag", "strong");
app.use(compression({ threshold: 512 }));
app.use(express.json({ limit: "4mb" }));
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
    recommendation_cache_entries: recommendationCache.size,
    tmdb_cache_entries: tmdbResponseCache.size,
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
    const [senderDefaults, recipientDefaults] = await Promise.all([
      getGlobalSharing(request.sender_id),
      getGlobalSharing(request.recipient_id),
    ]);
    await Promise.all([
      FriendPermission.findOneAndUpdate(
        { owner_id: request.sender_id, viewer_id: request.recipient_id },
        { $setOnInsert: senderDefaults },
        { upsert: true }
      ),
      FriendPermission.findOneAndUpdate(
        { owner_id: request.recipient_id, viewer_id: request.sender_id },
        { $setOnInsert: recipientDefaults },
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
    const [users, permissions, globalSharing] = await Promise.all([
      User.find({ _id: { $in: friendIds } }).select("username discoverable allow_friend_requests").lean(),
      FriendPermission.find({ owner_id: req.userId, viewer_id: { $in: friendIds } }).lean(),
      getGlobalSharing(req.userId),
    ]);
    const userMap = new Map(users.map((user) => [String(user._id), user]));
    const permissionMap = new Map(permissions.map((permission) => [String(permission.viewer_id), permission]));
    res.json(friendIds.map((id) => {
      const permission = permissionMap.get(String(id));
      return {
        ...publicUser(userMap.get(String(id))),
        sharing: permission ? cleanPermissions(permission) : globalSharing,
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
    res.json({ user: publicUser(viewer), permissions: permission ? cleanPermissions(permission) : await getGlobalSharing(req.userId) });
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

app.get("/api/social/sharing/defaults", authMiddleware, async (req, res) => {
  try {
    res.json({ permissions: await getGlobalSharing(req.userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/social/sharing/defaults", authMiddleware, async (req, res) => {
  try {
    const permissions = cleanPermissions(req.body?.permissions || req.body || {});
    await GlobalShareSetting.findOneAndUpdate(
      { owner_id: req.userId },
      { $set: permissions },
      { upsert: true, new: true, runValidators: true }
    );
    let applied = 0;
    if (req.body?.apply_to_existing === true) {
      const result = await FriendPermission.updateMany(
        { owner_id: req.userId },
        { $set: permissions }
      );
      applied = result.modifiedCount || 0;
    }
    res.json({ success: true, permissions, applied });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/social/sharing/bulk", authMiddleware, async (req, res) => {
  try {
    const usernames = Array.from(new Set(
      (Array.isArray(req.body?.usernames) ? req.body.usernames : [])
        .map(normalizeUsername)
        .filter(Boolean)
    )).slice(0, 250);
    if (!usernames.length) return res.status(400).json({ error: "Choose at least one friend" });
    const users = await User.find({ username_key: { $in: usernames } }).select("_id username username_key").lean();
    const friendshipKeys = new Set((await Friendship.find({ participants: req.userId }).select("pair_key").lean()).map((x) => x.pair_key));
    const allowed = users.filter((user) => friendshipKeys.has(socialPairKey(req.userId, user._id)));
    if (!allowed.length) return res.status(403).json({ error: "No valid friends selected" });
    const permissions = cleanPermissions(req.body?.permissions || {});
    await FriendPermission.bulkWrite(allowed.map((viewer) => ({
      updateOne: {
        filter: { owner_id: req.userId, viewer_id: viewer._id },
        update: { $set: permissions },
        upsert: true,
      },
    })));
    res.json({ success: true, permissions, updated: allowed.map((user) => user.username) });
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
    const permissions = permissionDoc ? cleanPermissions(permissionDoc) : await getGlobalSharing(owner._id);
    const scope = permissions.scope || (permissions.full_collection ? "all" : "filters");
    if (scope === "none") {
      return res.json({ owner: publicUser(owner), permissions, items: [], stats: { total: 0, movies: 0, series: 0 } });
    }

    let movieFilter = { user_id: owner._id };
    let seriesFilter = { user_id: owner._id };
    if (scope === "filters") {
      const visibility = [];
      if (permissions.watching) visibility.push({ watch_status: "watching" });
      if (permissions.watched) visibility.push({ watch_status: "watched" });
      if (permissions.favorites) visibility.push({ favorite: true });
      if (!visibility.length) {
        return res.json({ owner: publicUser(owner), permissions, items: [], stats: { total: 0, movies: 0, series: 0 } });
      }
      movieFilter.$or = visibility;
      seriesFilter.$or = visibility;
    } else if (scope === "selected" || scope === "all_except") {
      const selected = parseSelectedItems(permissions.selected_items);
      const include = scope === "selected";
      movieFilter = buildSelectedFilter(owner._id, "movie", selected, include);
      seriesFilter = buildSelectedFilter(owner._id, "series", selected, include);
      if (include && !movieFilter && !seriesFilter) {
        return res.json({ owner: publicUser(owner), permissions, items: [], stats: { total: 0, movies: 0, series: 0 } });
      }
    }

    const [movies, series] = await Promise.all([
      movieFilter ? Movie.find(movieFilter).sort({ updated_at: -1, order_number: -1 }).select("-notes -__v").lean() : [],
      seriesFilter ? Series.find(seriesFilter).sort({ updated_at: -1, order_number: -1 }).select("-notes -__v").lean() : [],
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

// ==================== Recommendations ====================

app.get("/api/recommendations", authMiddleware, async (req, res) => {
  const forceRefresh = String(req.query.refresh || "") === "1";
  if (!forceRefresh) {
    const cached = getCachedRecommendation(req.userId);
    if (cached) {
      res.set("X-Recommendation-Cache", "HIT");
      return res.json(cached);
    }
  }

  try {
    const payload = await buildRecommendationPayload(req.userId);
    setCachedRecommendation(req.userId, payload);
    res.set("X-Recommendation-Cache", "MISS");
    res.json(payload);
  } catch (error) {
    console.error("Recommendation engine error:", error);
    res.status(502).json({
      error: "Could not build recommendations right now",
      detail: process.env.NODE_ENV === "production" ? undefined : error.message,
    });
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
  if (Object.hasOwn(data, "poster_url") && data.poster_url != null) {
    const poster = String(data.poster_url)
    const allowedPoster = /^https?:\/\//i.test(poster) || /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(poster)
    if (!allowedPoster || poster.length > 1500000) data.poster_url = null
  }

  const allowed = [
    "title",
    "genre",
    "release_year",
    "rating",
    "poster_url",
    "tmdb_id",
    "notes",
    "watch_status",
    "watch_date",
    "favorite",
    "rewatch_count",
  ];
  if (type === "series") allowed.push("end_year", "number_of_seasons", "watched_seasons");
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
    invalidateUserRecommendationCache(req.userId);
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
    invalidateUserRecommendationCache(req.userId);
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
    invalidateUserRecommendationCache(req.userId);
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
      GlobalShareSetting.createIndexes(),
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
