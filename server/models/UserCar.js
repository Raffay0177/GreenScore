import mongoose from 'mongoose';

const userCarSchema = new mongoose.Schema(
    {
        userId: { type: String, required: true, index: true },
        label: { type: String, required: true, trim: true, maxlength: 120 },
        make: { type: String, trim: true, maxlength: 80, default: '' },
        model: { type: String, trim: true, maxlength: 80, default: '' },
        year: { type: Number, min: 1900, max: 2100 },
        estimatedKgPerTrip: { type: Number, default: 2.4, min: 0, max: 500 }
    },
    { timestamps: true }
);

userCarSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model('UserCar', userCarSchema);
