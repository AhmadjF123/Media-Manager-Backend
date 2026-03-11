const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors"); // ⬅️ تمت إضافة CORS

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

// ==================== Mongoose Schemas ====================
const movieSchema = new mongoose.Schema({
  title: { type: String, required: true },
  genre: { type: String, required: true },
  release_year: { type: Number, required: true },
  rating: { type: Number, default: 0 },
  poster_url: { type: String, default: null },
  order_number: { type: Number, required: true, default: 0 },
});

const seriesSchema = new mongoose.Schema({
  title: { type: String, required: true },
  genre: { type: String, required: true },
  release_year: { type: Number, required: true },
  end_year: { type: Number, default: null },
  rating: { type: Number, default: 0 },
  poster_url: { type: String, default: null },
  order_number: { type: Number, required: true, default: 0 },
});

const Movie = mongoose.model("Movie", movieSchema);
const Series = mongoose.model("Series", seriesSchema);

// ==================== Middleware ====================
app.use(express.json());
app.use(cors()); // ⬅️ السماح بجميع الطلبات عبر النطاقات (ضروري للاتصال من Vercel)

// (اختياري) إذا أردت الاحتفاظ بخدمة الملفات الثابتة، يمكنك إضافة السطر التالي، لكنه غير ضروري بعد الفصل.
// app.use(express.static(path.join(__dirname, "public")));

// ==================== API Routes ====================

// GET /api/media?type=movie|series
app.get("/api/media", async (req, res) => {
  const { type } = req.query;
  const Model = type === "movie" ? Movie : Series;

  try {
    const items = await Model.find().sort("order_number");
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
    // Get the current maximum order_number
    const lastItem = await Model.findOne().sort("-order_number");
    const newOrder = lastItem ? lastItem.order_number + 1 : 1;

    const newItem = new Model({
      ...data,
      order_number: newOrder,
    });

    await newItem.save();
    res.json({ success: true });
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

    // Reorder remaining items
    const remaining = await Model.find().sort("order_number");
    for (let i = 0; i < remaining.length; i++) {
      remaining[i].order_number = i + 1;
      await remaining[i].save();
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

// (اختياري) يمكن حذف هذا المسار إذا لم تعد بحاجة لخدمة index.html
// app.get("/", (req, res) => {
//   res.send("Backend is running. Use /api/media endpoints.");
// });

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});