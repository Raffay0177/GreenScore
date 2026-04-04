import mongoose from 'mongoose';

const userMetricSchema = new mongoose.Schema({
  userId: { type: String, default: 'default_user' },
  currentEmissions: { type: Number, default: 0 },
  dailyGoal: { type: Number, default: 47 },
  streak: { type: Number, default: 12 },
  lastLogged: { type: Date, default: Date.now }
});

export default mongoose.model('UserMetric', userMetricSchema);
