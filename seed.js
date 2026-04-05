import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Activity from './server/models/Activity.js';
import UserMetric from './server/models/UserMetric.js';
import Receipt from './server/models/Receipt.js';

dotenv.config();

const DEMO_USER_ID = 'seed_demo_user';

const sampleActivities = [
  { userId: DEMO_USER_ID, label: 'Beef Burger', value: 4.5, icon: 'utensils', intensity: 'High', source: 'manual' },
  { userId: DEMO_USER_ID, label: 'Morning Coffee', value: 0.4, icon: 'coffee', intensity: 'Low', source: 'manual' },
  { userId: DEMO_USER_ID, label: 'Car Commute (15km)', value: 2.1, icon: 'car', intensity: 'High', source: 'manual' },
  { userId: DEMO_USER_ID, label: 'Chicken Salad', value: 1.2, icon: 'utensils', intensity: 'Low', source: 'manual' },
  { userId: DEMO_USER_ID, label: 'Online Shopping', value: 0.8, icon: 'shopping-bag', intensity: 'Low', source: 'manual' }
];

const sampleMetric = {
  userId: DEMO_USER_ID,
  currentEmissions: 9.0,
  dailyGoal: 47,
  streak: 3,
  lastLogged: new Date()
};

async function seed() {
  try {
    if (!process.env.MONGO_URI) {
      console.error('❌ MONGO_URI not found in .env');
      process.exit(1);
    }

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected!');

    await Activity.deleteMany({ userId: DEMO_USER_ID });
    await UserMetric.deleteMany({ userId: DEMO_USER_ID });
    await Receipt.deleteMany({ userId: DEMO_USER_ID });
    console.log('🧹 Cleared old seed data for demo user');

    await Activity.insertMany(sampleActivities);
    await UserMetric.create(sampleMetric);
    console.log('🌱 Seeded activities, user metrics (collections: activities, usermetrics)');

    console.log('\n✅ Done! Database is ready.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  }
}

seed();
