import mongoose from 'mongoose';

const userMetricSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  currentEmissions: { type: Number, default: 0, min: 0 },
  dailyGoal: { type: Number, default: 47, min: 1 },
  streak: { type: Number, default: 0, min: 0 },
  lastLogged: { type: Date }
});

export default mongoose.model('UserMetric', userMetricSchema);
