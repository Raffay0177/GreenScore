import mongoose from 'mongoose';

const receiptSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  imageBase64: { type: String, required: true }, // Stores the compressed image
  items: [{
    label: String,
    value: Number, // CO2 value
    count: Number,
    category: String
  }],
  totalCO2: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
});

export default mongoose.model('Receipt', receiptSchema);
