const mongoose = require("mongoose");

const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://admin:admin123@cluster0.1x1ifj7.mongodb.net/media_manager?retryWrites=true&w=majority";

const MEDIA_INDEXES = [
  [{ user_id: 1, order_number: 1 }, { name: "user_order_idx" }],
  [{ user_id: 1, _id: -1 }, { name: "user_added_idx" }],
  [
    { user_id: 1, title: 1, order_number: 1 },
    {
      name: "user_title_idx",
      collation: { locale: "en", strength: 2, numericOrdering: true },
    },
  ],
  [{ user_id: 1, release_year: -1, order_number: -1 }, { name: "user_year_idx" }],
  [{ user_id: 1, rating: -1, order_number: -1 }, { name: "user_rating_idx" }],
  [{ user_id: 1, genre: 1 }, { name: "user_genre_idx" }],
];

async function createMediaIndexes(collection) {
  for (const [keys, options] of MEDIA_INDEXES) {
    await collection.createIndex(keys, options);
  }
}

async function run() {
  await mongoose.connect(MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10_000,
    family: 4,
  });

  const db = mongoose.connection.db;
  await Promise.all([
    db.collection("users").createIndex({ username: 1 }, { unique: true, name: "username_unique" }),
    db.collection("users").createIndex({ email: 1 }, { unique: true, name: "email_unique" }),
    createMediaIndexes(db.collection("movies")),
    createMediaIndexes(db.collection("series")),
  ]);

  console.log("✅ All Media Manager indexes are ready");
  await mongoose.connection.close();
}

run().catch(async (error) => {
  console.error("❌ Could not create indexes:", error.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
