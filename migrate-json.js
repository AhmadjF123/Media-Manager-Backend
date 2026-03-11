const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// ===== الاتصال بـ MongoDB (استخدم نفس رابط الاتصال من server.js) =====
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://admin:admin123@cluster0.1x1ifj7.mongodb.net/media_manager?retryWrites=true&w=majority";


mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ متصل بـ MongoDB'))
  .catch(err => {
    console.error('❌ فشل الاتصال:', err);
    process.exit(1);
  });

// ===== تعريف المخططات (يجب أن تتطابق مع server.js) =====
const movieSchema = new mongoose.Schema({
  title: String,
  genre: String,
  release_year: Number,
  rating: Number,
  poster_url: { type: String, default: null },
  order_number: Number,
});

const seriesSchema = new mongoose.Schema({
  title: String,
  genre: String,
  release_year: Number,
  end_year: { type: Number, default: null },
  rating: Number,
  poster_url: { type: String, default: null },
  order_number: Number,
  seasons: { type: Number, default: 1 }, // أضفنا هذا الحقل
});

const Movie = mongoose.model('Movie', movieSchema);
const Series = mongoose.model('Series', seriesSchema);

// ===== قراءة ملف JSON واستخراج البيانات =====
async function migrate() {
  try {
    const jsonPath = path.join(__dirname, 'media_db.json');
    const rawData = fs.readFileSync(jsonPath, 'utf8');
    const jsonArray = JSON.parse(rawData);

    let moviesData = [];
    let seriesData = [];

    for (const item of jsonArray) {
      if (item.type === 'table' && item.name === 'movies') {
        moviesData = item.data;
        console.log(`🎬 تم العثور على ${moviesData.length} فيلم.`);
      } else if (item.type === 'table' && item.name === 'series') {
        seriesData = item.data;
        console.log(`📺 تم العثور على ${seriesData.length} مسلسل.`);
      }
    }

    // حذف البيانات القديمة (اختياري – يمكنك إزالة هذين السطرين إذا أردت الاحتفاظ بالبيانات الموجودة)
    await Movie.deleteMany({});
    await Series.deleteMany({});

    // إدراج الأفلام
    if (moviesData.length > 0) {
      const preparedMovies = moviesData.map(m => ({
        ...m,
        release_year: Number(m.release_year),
        rating: Number(m.rating),
        order_number: Number(m.order_number),
        poster_url: m.poster_url === 'null' ? null : m.poster_url,
      }));
      await Movie.insertMany(preparedMovies);
      console.log('✅ تم إدراج الأفلام بنجاح');
    }

    // إدراج المسلسلات
    if (seriesData.length > 0) {
      const preparedSeries = seriesData.map(s => ({
        ...s,
        release_year: Number(s.release_year),
        end_year: s.end_year ? Number(s.end_year) : null,
        rating: Number(s.rating),
        order_number: Number(s.order_number),
        poster_url: s.poster_url === 'null' ? null : s.poster_url,
        // seasons غير موجود في JSON، سيأخذ القيمة الافتراضية 1 من المخطط
      }));
      await Series.insertMany(preparedSeries);
      console.log('✅ تم إدراج المسلسلات بنجاح');
    }

    console.log('🎉 انتهت عملية الترحيل!');
  } catch (err) {
    console.error('❌ خطأ:', err);
  } finally {
    mongoose.disconnect();
  }
}

migrate();