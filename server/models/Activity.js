import mongoose from 'mongoose';

const activitySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  label: { type: String, required: true },
  value: { type: Number, required: true },
  icon: { type: String, required: true },
  intensity: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

export default mongoose.model('Activity', activitySchema);
