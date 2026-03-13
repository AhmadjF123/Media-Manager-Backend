const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const compression = require("compression"); // ✅ لضغط الاستجابات

const app = express();
const PORT = process.env.PORT || 3000;

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

// ==================== Mongoose Schemas with Indexes ====================
// إضافة فهارس لتسريع البحث
const movieSchema = new mongoose.Schema({
  title: { type: String, required: true, index: true },
  genre: { type: String, required: true, index: true },
  release_year: { type: Number, required: true, index: true },
  rating: { type: Number, default: 0, index: true },
  poster_url: { type: String, default: null },
  order_number: { type: Number, required: true, default: 0 },
});

const seriesSchema = new mongoose.Schema({
  title: { type: String, required: true, index: true },
  genre: { type: String, required: true, index: true },
  release_year: { type: Number, required: true, index: true },
  end_year: { type: Number, default: null },
  rating: { type: Number, default: 0, index: true },
  poster_url: { type: String, default: null },
  order_number: { type: Number, required: true, default: 0 },
});

const Movie = mongoose.model("Movie", movieSchema);
const Series = mongoose.model("Series", seriesSchema);

// ==================== Middleware ====================
app.use(compression()); // ضغط الاستجابات
app.use(express.json({ limit: "1mb" })); // تحديد حجم الطلبات
app.use(cors());

// تخزين الملفات الثابتة مؤقتاً (إذا كنت تخدمها من الخادم نفسه)
// app.use(express.static("public", { maxAge: "1h" }));

// ==================== API Routes ====================

// ✅ نقطة نهاية واحدة تجلب جميع الوسائط مع إمكانية البحث والتصفية
app.get("/api/media/all", async (req, res) => {
  const { search, by, type } = req.query; // type: movie/series/all
  let filter = {};

  // بناء فلتر البحث
  if (search && by) {
    if (by === "title") filter.title = { $regex: search, $options: "i" };
    else if (by === "genre") filter.genre = { $regex: search, $options: "i" };
    else if (by === "release_year") filter.release_year = parseInt(search);
    else if (by === "rating") filter.rating = parseFloat(search);
  }

  try {
    let movies = [],
      series = [];
    if (type === "all" || type === "movie") {
      movies = await Movie.find(filter).sort("order_number").lean();
    }
    if (type === "all" || type === "series") {
      series = await Series.find(filter).sort("order_number").lean();
    }

    // توحيد النتائج مع إضافة media_type
    const results = [
      ...movies.map((m) => ({ ...m, media_type: "movie" })),
      ...series.map((s) => ({ ...s, media_type: "series" })),
    ].sort((a, b) => a.order_number - b.order_number);

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/media?type=movie|series (يبقى للتوافق مع الكود القديم)
app.get("/api/media", async (req, res) => {
  const { type } = req.query;
  const Model = type === "movie" ? Movie : Series;
  try {
    const items = await Model.find().sort("order_number").lean();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/media → add new item
app.post("/api/media", async (req, res) => {
  const { type, data } = req.body;
  const Model = type === "movie" ? Movie : Series;
  try {
    const lastItem = await Model.findOne().sort("-order_number");
    const newOrder = lastItem ? lastItem.order_number + 1 : 1;
    const newItem = new Model({ ...data, order_number: newOrder });
    await newItem.save();
    res.json({ success: true, order_number: newOrder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/media → edit an item
app.put("/api/media", async (req, res) => {
  const { type, order_number, data } = req.body;
  if (!type || !order_number || !data) {
    return res.status(400).json({ error: "Invalid request data" });
  }
  const Model = type === "movie" ? Movie : Series;
  try {
    const item = await Model.findOne({ order_number });
    if (!item) {
      return res
        .status(404)
        .json({ error: `Item not found with order number ${order_number}` });
    }
    await Model.updateOne({ order_number }, data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/media → delete an item
app.delete("/api/media", async (req, res) => {
  const { type, order_number } = req.body;
  const Model = type === "movie" ? Movie : Series;
  try {
    await Model.deleteOne({ order_number });
    // Reorder remaining items in one bulk operation
    const remaining = await Model.find().sort("order_number").lean();
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

// ==================== Debug Route ====================
app.get("/debug", async (req, res) => {
  try {
    const movies = await Movie.find().limit(5);
    const series = await Series.find().limit(5);
    res.json({
      status: "connected",
      movies_sample: movies,
      series_sample: series,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});