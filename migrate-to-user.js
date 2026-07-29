// ════════════════════════════════════════════════════════
//  migrate-to-user.js
//  يربط الداتا الموجودة بحساب مستخدم معيّن
//
//  الاستخدام:
//    node migrate-to-user.js --email="your@email.com" --password="yourpassword"
//
//  إذا الحساب مش موجود → بيعمله تلقائياً
//  إذا موجود → بيسجّل دخول ويربط الداتا فيه
// ════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");

// ── اقرأ المعطيات من command line ──
const args = {};
process.argv.slice(2).forEach(arg => {
  const [key, val] = arg.replace(/^--/, "").split("=");
  args[key] = val;
});

const EMAIL    = args.email;
const PASSWORD = args.password;
const USERNAME = args.username || EMAIL?.split("@")[0] || "admin";

if (!EMAIL || !PASSWORD) {
  console.error("❌ الاستخدام: node migrate-to-user.js --email=YOUR_EMAIL --password=YOUR_PASSWORD");
  console.error("   مثال:    node migrate-to-user.js --email=ali@gmail.com --password=mypass123");
  process.exit(1);
}

// ── MongoDB ──
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://admin:admin123@cluster0.1x1ifj7.mongodb.net/media_manager?retryWrites=true&w=majority";

// الاتصال يصير داخل run() بعدين

// ── Schemas (نفس server.js) ──
const userSchema = new mongoose.Schema({
  username:   { type: String, required: true, unique: true, trim: true },
  email:      { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:   { type: String, required: true },
  created_at: { type: Date, default: Date.now },
});

const movieSchema = new mongoose.Schema({
  user_id:      { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  title:        String,
  genre:        String,
  release_year: Number,
  rating:       Number,
  poster_url:   { type: String, default: null },
  order_number: Number,
});

const seriesSchema = new mongoose.Schema({
  user_id:      { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  title:        String,
  genre:        String,
  release_year: Number,
  end_year:     { type: Number, default: null },
  rating:       Number,
  poster_url:   { type: String, default: null },
  order_number: Number,
});

const User   = mongoose.model("User",   userSchema);
const Movie  = mongoose.model("Movie",  movieSchema);
const Series = mongoose.model("Series", seriesSchema);

// ════════════════════════════════════════════════
async function run() {
  try {

    // 0. اتصل بـ MongoDB وانتظر
    await mongoose.connect(MONGODB_URI);
    console.log("✅ متصل بـ MongoDB");

    // 1. ابحث عن الحساب أو أنشئه
    let user = await User.findOne({ email: EMAIL.toLowerCase() });

    if (user) {
      // تحقق من الباسوورد
      const match = await bcrypt.compare(PASSWORD, user.password);
      if (!match) {
        console.error("❌ الباسوورد غلط لهذا الإيميل");
        process.exit(1);
      }
      console.log(`👤 وُجد الحساب: ${user.username} (${user.email})`);
    } else {
      // أنشئ حساب جديد
      if (PASSWORD.length < 6) {
        console.error("❌ الباسوورد يجب أن يكون 6 أحرف على الأقل");
        process.exit(1);
      }
      const hashed = await bcrypt.hash(PASSWORD, 10);
      user = new User({ username: USERNAME, email: EMAIL.toLowerCase(), password: hashed });
      await user.save();
      console.log(`🆕 تم إنشاء حساب جديد: ${user.username} (${user.email})`);
    }

    const userId = user._id;

    // 2. عدّ الداتا القديمة (بدون user_id)
    const orphanMovies  = await Movie.countDocuments({ user_id: { $exists: false } });
    const orphanSeries  = await Series.countDocuments({ user_id: { $exists: false } });
    const alreadyMovies = await Movie.countDocuments({ user_id: userId });
    const alreadySeries = await Series.countDocuments({ user_id: userId });

    console.log("\n📊 إحصائيات الداتا:");
    console.log(`   أفلام بدون مالك:     ${orphanMovies}`);
    console.log(`   مسلسلات بدون مالك:   ${orphanSeries}`);
    console.log(`   أفلام مرتبطة فيك:    ${alreadyMovies}`);
    console.log(`   مسلسلات مرتبطة فيك:  ${alreadySeries}`);

    if (orphanMovies === 0 && orphanSeries === 0) {
      console.log("\n✅ لا يوجد داتا قديمة للترحيل. كل شي منسوب بالفعل.");
      return;
    }

    // 3. اربط الداتا القديمة بالمستخدم
    console.log(`\n🔄 جاري ربط الداتا بحساب: ${user.username}...`);

    const moviesResult  = await Movie.updateMany(
      { user_id: { $exists: false } },
      { $set: { user_id: userId } }
    );
    const seriesResult  = await Series.updateMany(
      { user_id: { $exists: false } },
      { $set: { user_id: userId } }
    );

    console.log(`\n🎬 أفلام تم ربطها:      ${moviesResult.modifiedCount}`);
    console.log(`📺 مسلسلات تم ربطها:    ${seriesResult.modifiedCount}`);
    console.log(`\n🎉 انتهى الترحيل! كل الداتا الآن منسوبة لحساب: ${user.username}`);
    console.log(`\n💡 الآن سجّل دخول بـ:`);
    console.log(`   الإيميل:   ${EMAIL}`);
    console.log(`   الباسوورد: ${PASSWORD}`);

  } catch (err) {
    console.error("❌ خطأ:", err.message);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 انقطع الاتصال بـ MongoDB");
  }
}

run();