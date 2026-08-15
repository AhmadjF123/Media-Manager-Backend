const mongoose = require("mongoose");

const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://admin:admin123@cluster0.1x1ifj7.mongodb.net/media_manager?retryWrites=true&w=majority";

const MEDIA_INDEXES = [
  [{ user_id: 1, order_number: 1 }, { name: "user_order_idx" }],
  [{ user_id: 1, _id: -1 }, { name: "user_added_idx" }],
  [
    { user_id: 1, title: 1, order_number: 1 },
    { name: "user_title_idx", collation: { locale: "en", strength: 2, numericOrdering: true } },
  ],
  [{ user_id: 1, release_year: -1, order_number: -1 }, { name: "user_year_idx" }],
  [{ user_id: 1, rating: -1, order_number: -1 }, { name: "user_rating_idx" }],
  [{ user_id: 1, genre: 1 }, { name: "user_genre_idx" }],
  [{ user_id: 1, watch_status: 1, updated_at: -1 }, { name: "user_watch_status_idx" }],
  [{ user_id: 1, favorite: 1, updated_at: -1 }, { name: "user_favorite_idx" }],
  [{ user_id: 1, tmdb_id: 1 }, { name: "user_tmdb_idx" }],
];

async function createMediaIndexes(collection) {
  for (const [keys, options] of MEDIA_INDEXES) await collection.createIndex(keys, options);
}


function normalizeLegacyUsername(value) {
  let key = String(value || "").trim().replace(/^@+/, "").toLowerCase()
    .replace(/[\s.-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  if (key.length < 3) key = `user_${key || "member"}`.slice(0, 20);
  return key;
}

async function backfillUsernameKeys(users) {
  const existing = await users.find({ username_key: { $exists: true, $nin: [null, ""] } }, { projection: { username_key: 1 } }).toArray();
  const used = new Set(existing.map((user) => user.username_key));
  const missing = await users.find({ $or: [{ username_key: { $exists: false } }, { username_key: null }, { username_key: "" }] }, { projection: { username: 1 } }).toArray();
  await users.updateMany({ discoverable: { $exists: false } }, { $set: { discoverable: true } });
  await users.updateMany({ allow_friend_requests: { $exists: false } }, { $set: { allow_friend_requests: true } });
  for (const user of missing) {
    const base = normalizeLegacyUsername(user.username);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      const tail = `_${suffix++}`;
      candidate = `${base.slice(0, 20 - tail.length)}${tail}`;
    }
    used.add(candidate);
    await users.updateOne({ _id: user._id }, { $set: { username_key: candidate, discoverable: true, allow_friend_requests: true } });
  }
}

async function run() {
  await mongoose.connect(MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10_000,
    family: 4,
  });

  const db = mongoose.connection.db;
  await backfillUsernameKeys(db.collection("users"));
  await Promise.all([
    db.collection("users").createIndex({ username: 1 }, { unique: true }),
    db.collection("users").createIndex({ username_key: 1 }, { unique: true }),
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("users").createIndex({ discoverable: 1, username_key: 1 }, { name: "discoverable_username_idx" }),
    createMediaIndexes(db.collection("movies")),
    createMediaIndexes(db.collection("series")),
    db.collection("friendships").createIndex({ pair_key: 1 }, { unique: true }),
    db.collection("friendships").createIndex({ participants: 1, created_at: -1 }, { name: "friend_participants_idx" }),
    db.collection("friendrequests").createIndex({ pair_key: 1 }, { unique: true }),
    db.collection("friendrequests").createIndex({ recipient_id: 1, created_at: -1 }, { name: "incoming_requests_idx" }),
    db.collection("friendrequests").createIndex({ sender_id: 1, created_at: -1 }, { name: "outgoing_requests_idx" }),
    db.collection("friendpermissions").createIndex(
      { owner_id: 1, viewer_id: 1 },
      { unique: true, name: "owner_viewer_permission_idx" }
    ),
    db.collection("globalsharesettings").createIndex(
      { owner_id: 1 },
      { unique: true, name: "global_share_owner_idx" }
    ),
    db.collection("blocks").createIndex({ pair_key: 1 }, { unique: true }),
    db.collection("blocks").createIndex({ blocker_id: 1, created_at: -1 }, { name: "blocker_idx" }),
    db.collection("invitecodes").createIndex({ code_hash: 1 }, { unique: true }),
    db.collection("invitecodes").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: "invite_expiry_ttl" }),
    db.collection("invitecodes").createIndex({ owner_id: 1, created_at: -1 }, { name: "invite_owner_idx" }),
  ]);

  console.log("✅ All Media Manager, social and recommendation indexes are ready");
  await mongoose.connection.close();
}

run().catch(async (error) => {
  console.error("❌ Could not create indexes:", error.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
