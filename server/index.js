import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { auth } from 'express-oauth2-jwt-bearer';
import Activity from './models/Activity.js';
import UserMetric from './models/UserMetric.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Auth0 Middleware
const checkJwt = auth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}/`,
  tokenSigningAlg: 'RS256'
});

app.use(cors());
app.use(express.json());

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

    const activities = await Activity.find({ userId }).sort({ timestamp: -1 }).limit(10);

    res.json({
      dailyGoal: metrics.dailyGoal,
      currentEmissions: metrics.currentEmissions,
      streak: metrics.streak,
      activities: activities,
      aiTips: [
        { id: 101, text: "Your recent activities show a high carbon footprint. Try swapping beef for plant-based alternatives." },
        { id: 102, text: "Commuting by public transport could save up to 30% on your daily emissions." }
      ]
    });
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
      { $inc: { currentEmissions: value } },
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
