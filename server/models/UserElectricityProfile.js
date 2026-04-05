import mongoose from 'mongoose';

const userElectricityProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  householdSize: { type: Number, required: true, min: 1 },
  houseSizeStr: { type: String, default: 'Medium' },
  hasSolar: { type: Boolean, default: false },
  solarKw: { type: Number, default: 0 },
  locationStr: { type: String, default: 'Unknown' },
  dailyKgCo2e: { type: Number, required: true },
  details: { type: String, default: '' },
  solarExplainer: { type: String, default: '' },
  lastAutoLoggedDate: { type: Date, required: true }
});

export default mongoose.model('UserElectricityProfile', userElectricityProfileSchema);
