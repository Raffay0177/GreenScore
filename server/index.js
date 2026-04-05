import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { auth } from 'express-oauth2-jwt-bearer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Activity from './models/Activity.js';
import UserMetric from './models/UserMetric.js';
import Receipt from './models/Receipt.js';
import UserCar from './models/UserCar.js';

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id;
}

dotenv.config();

const genAI = process.env.GOOGLE_API_KEY ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null;

const app = express();
const PORT = process.env.PORT || 3000;

// Auth0 Middleware
const checkJwt = auth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}/`,
  tokenSigningAlg: 'RS256'
});

app.use(cors());
app.use(express.json({ limit: '4mb' }));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB (Local Compass)'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// GET Full State (Protected)
app.get('/api/carbon', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  try {
    let metrics = await UserMetric.findOne({ userId });
    if (!metrics) {
      metrics = await UserMetric.create({ userId });
    }

    const activities = await Activity.find({ userId }).sort({ timestamp: -1 }).limit(400).lean();
    const receiptIds = [
      ...new Set(activities.map((a) => a.receiptId).filter(Boolean).map((id) => String(id)))
    ];
    const receiptPreviews = {};
    if (receiptIds.length) {
      const recs = await Receipt.find({ _id: { $in: receiptIds }, userId })
        .select('imageBase64')
        .lean();
      for (const r of recs) receiptPreviews[String(r._id)] = r.imageBase64;
    }

    res.json({
      dailyGoal: metrics.dailyGoal,
      currentEmissions: metrics.currentEmissions,
      streak: metrics.streak,
      activities,
      receiptPreviews,
      aiTips: [
        { id: 101, text: "Your recent activities show a high carbon footprint. Try swapping beef for plant-based alternatives." },
        { id: 102, text: "Commuting by public transport could save up to 30% on your daily emissions." }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE single activity (adjust running total)
app.delete('/api/activities/:id', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(400).json({ error: 'Invalid activity id' });
  }
  try {
    const act = await Activity.findOne({ _id: id, userId });
    if (!act) return res.status(404).json({ error: 'Activity not found' });

    const value = Number(act.value) || 0;
    await Activity.deleteOne({ _id: act._id });
    await UserMetric.updateOne({ userId }, { $inc: { currentEmissions: -value } });
    await UserMetric.updateOne({ userId, currentEmissions: { $lt: 0 } }, { $set: { currentEmissions: 0 } });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- User cars (garage) ---
app.get('/api/cars', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  try {
    const cars = await UserCar.find({ userId }).sort({ createdAt: -1 }).lean();
    res.json(cars);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cars', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  const { label, make, model, year, estimatedKgPerTrip } = req.body;
  try {
    const l = String(label || '').trim();
    if (!l) return res.status(400).json({ error: 'label is required' });
    const kg = Math.max(0, Math.min(500, Number(estimatedKgPerTrip) || 2.4));
    const car = await UserCar.create({
      userId,
      label: l.slice(0, 120),
      make: String(make || '').trim().slice(0, 80),
      model: String(model || '').trim().slice(0, 80),
      year: year != null && year !== '' ? Math.floor(Number(year)) : undefined,
      estimatedKgPerTrip: kg
    });
    res.status(201).json(car);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/cars/:id', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  const { id } = req.params;
  if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid car id' });
  try {
    const car = await UserCar.findOneAndDelete({ _id: id, userId });
    if (!car) return res.status(404).json({ error: 'Car not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cars/match-image', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  const { image } = req.body;
  try {
    if (!genAI || !process.env.GOOGLE_API_KEY) {
      return res.status(503).json({ error: 'Car image matching is not configured (missing GOOGLE_API_KEY).' });
    }
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'image (base64 data URL) is required' });
    }
    const cars = await UserCar.find({ userId }).sort({ createdAt: -1 }).lean();
    const garage = cars.map((c) => ({
      id: String(c._id),
      label: c.label,
      make: c.make || '',
      model: c.model || ''
    }));

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const base64Data = image.includes(',') ? image.split(',')[1] : image;
    const mimeType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

    const prompt = `You are identifying a vehicle from a photo for a carbon-tracking app.
The user may already have these cars in their garage (JSON array). Pick the single best match if the photo clearly shows the same vehicle type/brand/model family as one entry; otherwise treat as a new vehicle.
Garage: ${JSON.stringify(garage)}

Return ONLY valid JSON (no markdown):
{
  "matchType": "existing" or "new",
  "matchedCarId": "<one of the garage id strings or null if new>",
  "suggested": {
    "label": "short display name e.g. Blue Civic",
    "make": "",
    "model": "",
    "estimatedKgPerTrip": 2.4
  },
  "confidence": 0.85,
  "shortReason": "one sentence"
}
Rules: estimatedKgPerTrip is approximate kg CO2 for a typical short commute trip (3–15 mi) for that vehicle; use 1.2–2.0 for small EV/hybrid, 2–4 for average sedan, 4–8 for SUV/truck.`;

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: base64Data, mimeType } }
    ]);
    const responseText = result.response.text();
    const cleanJson = responseText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    const matchType = parsed.matchType === 'existing' ? 'existing' : 'new';
    let matchedCarId = parsed.matchedCarId != null ? String(parsed.matchedCarId) : null;
    if (matchType === 'existing' && matchedCarId && !garage.some((g) => g.id === matchedCarId)) {
      matchedCarId = null;
    }
    const sug = parsed.suggested || {};
    const suggested = {
      label: String(sug.label || 'My vehicle').trim().slice(0, 120) || 'My vehicle',
      make: String(sug.make || '').trim().slice(0, 80),
      model: String(sug.model || '').trim().slice(0, 80),
      estimatedKgPerTrip: Math.max(0.1, Math.min(50, Number(sug.estimatedKgPerTrip) || 2.4))
    };
    res.json({
      matchType: matchedCarId ? 'existing' : 'new',
      matchedCarId,
      suggested,
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
      shortReason: String(parsed.shortReason || '').slice(0, 300)
    });
  } catch (err) {
    console.error('Car match error:', err);
    res.status(500).json({ error: err.message || 'Could not analyze image' });
  }
});

// POST Log Activity (Protected)
app.post('/api/log', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  const { label, value, icon, intensity, carId, temporaryCar } = req.body;
  try {
    let carObjectId = null;
    let tempFlag = Boolean(temporaryCar);
    if (carId && isValidObjectId(String(carId))) {
      const owned = await UserCar.findOne({ _id: carId, userId }).select('_id').lean();
      if (owned) carObjectId = owned._id;
    }
    if (tempFlag) carObjectId = null;

    const newActivity = await Activity.create({
      userId,
      label,
      value,
      icon,
      intensity,
      carId: carObjectId,
      temporaryCar: tempFlag
    });
    
    // Update Metrics
    await UserMetric.findOneAndUpdate(
      { userId },
      {
        $inc: { currentEmissions: value },
        $set: { lastLogged: new Date() },
        $setOnInsert: { dailyGoal: 47, streak: 0 }
      },
      { new: true, upsert: true }
    );

    res.status(201).json(newActivity);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
