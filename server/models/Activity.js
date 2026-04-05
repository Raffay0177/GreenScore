import mongoose from 'mongoose';

const activitySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  label: { type: String, required: true, trim: true, maxlength: 200 },
  value: { type: Number, required: true, min: 0 },
  icon: { type: String, required: true, trim: true, maxlength: 64 },
  intensity: {
    type: String,
    required: true,
    enum: ['Low', 'Medium', 'High']
  },
  source: {
    type: String,
    enum: ['manual', 'receipt'],
    default: 'manual'
  },
  receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt', default: null },
  carId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserCar', default: null },
  temporaryCar: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now }
});

activitySchema.index({ userId: 1, timestamp: -1 });

export default mongoose.model('Activity', activitySchema);
