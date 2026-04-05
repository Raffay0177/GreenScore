import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { auth } from 'express-oauth2-jwt-bearer';
import Activity from '../server/models/Activity.js';
import UserMetric from '../server/models/UserMetric.js';
import Receipt from '../server/models/Receipt.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id;
}

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const app = express();

// Auth0 Middleware
const checkJwt = auth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}/`,
  tokenSigningAlg: 'RS256'
});

app.use(cors());
// Default 100kb is too small for base64 receipt images; Vercel caps total request ~4.5MB.
app.use(express.json({ limit: '4mb' }));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB (Vercel Serverless)'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// GET Full State (Protected)
app.get('/api/carbon', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  try {
    let metrics = await UserMetric.findOne({ userId });
    if (!metrics) {
      metrics = await UserMetric.create({ userId });
    }

    const activities = await Activity.find({ userId }).sort({ timestamp: -1 }).limit(400);

    res.json({
      dailyGoal: metrics.dailyGoal,
      currentEmissions: metrics.currentEmissions,
      streak: metrics.streak,
      activities,
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

// POST Log Activity (Protected)
app.post('/api/log', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  const { label, value, icon, intensity } = req.body;
  try {
    const newActivity = await Activity.create({ userId, label, value, icon, intensity });
    
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

// POST Scan Receipt (Protected)
app.post('/api/scan', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  const { image } = req.body;

  try {
    if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
        throw new Error("Gemini API Key is missing. Please add it to your .env file.");
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const base64Data = image.split(',')[1];

    const prompt = `
      Analyze this grocery receipt. 
      Identify every food or shopping item and estimate its carbon footprint in kg CO2.
      Use your knowledge of agricultural impact (e.g., beef is high, vegetables are low).
      Return ONLY a JSON object in this format:
      {
        "items": [
          {"label": "Apples", "value": 0.3, "count": 1, "category": "Food"},
          {"label": "Beef Burger", "value": 4.5, "count": 1, "category": "Food"}
        ],
        "totalCO2": 4.8
      }
    `;

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: base64Data, mimeType: "image/jpeg" } }
    ]);

    const responseText = result.response.text();
    const cleanJson = responseText.replace(/```json|```/g, "").trim();
    const parsedData = JSON.parse(cleanJson);

    const rawItems = Array.isArray(parsedData.items) ? parsedData.items : [];
    const items = rawItems.map((it) => ({
      label: (String(it?.label ?? 'Item').trim().slice(0, 200)) || 'Item',
      value: Math.max(0, Number(it?.value) || 0),
      count: Math.max(1, Math.floor(Number(it?.count) || 1)),
      category:
        typeof it?.category === 'string' && it.category.trim()
          ? it.category.trim().slice(0, 80)
          : 'General'
    }));
    let totalCO2 = Math.max(0, Number(parsedData.totalCO2));
    if (!Number.isFinite(totalCO2)) {
      totalCO2 = items.reduce((sum, row) => sum + row.value, 0);
    }

    const newReceipt = await Receipt.create({
      userId,
      imageBase64: image,
      items,
      totalCO2
    });

    const now = new Date();
    for (const item of items) {
      await Activity.create({
        userId,
        label: item.label,
        value: item.value,
        icon: item.category === 'Food' ? 'utensils' : 'shopping-bag',
        intensity: item.value > 2 ? 'High' : 'Low',
        source: 'receipt'
      });

      await UserMetric.findOneAndUpdate(
        { userId },
        {
          $inc: { currentEmissions: item.value },
          $set: { lastLogged: now },
          $setOnInsert: { dailyGoal: 47, streak: 0 }
        },
        { upsert: true }
      );
    }

    res.json(newReceipt);
  } catch (err) {
    console.error("AI Scan Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET Receipts History
app.get('/api/receipts', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  try {
    const receipts = await Receipt.find({ userId }).sort({ timestamp: -1 });
    res.json(receipts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE Receipt
app.delete('/api/receipts/:id', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  try {
    const receipt = await Receipt.findOne({ _id: req.params.id, userId });
    if (!receipt) return res.status(404).json({ error: "Receipt not found" });

    // Note: This only deletes the receipt entry, not the individual activities 
    // it generated, to keep the historical footprint intact.
    await Receipt.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a test route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'GreenScore API is healthy' });
});

export default app;
