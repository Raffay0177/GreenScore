import mongoose from 'mongoose';

const receiptItemSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 200 },
    value: { type: Number, required: true, min: 0 },
    count: { type: Number, default: 1, min: 1 },
    category: { type: String, trim: true, maxlength: 80, default: 'General' }
  },
  { _id: false }
);

const receiptSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  imageBase64: { type: String, required: true },
  items: { type: [receiptItemSchema], default: [] },
  totalCO2: { type: Number, default: 0, min: 0 },
  timestamp: { type: Date, default: Date.now }
});

receiptSchema.index({ userId: 1, timestamp: -1 });

export default mongoose.model('Receipt', receiptSchema);
