import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { auth } from 'express-oauth2-jwt-bearer';
import Activity from '../server/models/Activity.js';
import UserMetric from '../server/models/UserMetric.js';
import Receipt from '../server/models/Receipt.js';
import UserCar from '../server/models/UserCar.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id;
}

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

/**
 * Helper to fetch accurate carbon data from Climatiq.io
 * FALLBACK: If Climatiq has no match, it returns null.
 */
async function getClimatiqEmission(query) {
  if (!process.env.CLIMATIQ_API_KEY) return null;
  
  try {
    // 1. Search for the emission factor (GET method)
    const url = new URL('https://api.climatiq.io/data/v1/search');
    url.searchParams.append('query', query);
    url.searchParams.append('data_version', '^2');
    url.searchParams.append('results_per_page', '1');

    const searchRes = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.CLIMATIQ_API_KEY}`
      }
    });

    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    
    if (!searchData.results || searchData.results.length === 0) return null;
    
    const factor = searchData.results[0];
    
    // 2. Perform the estimate (default 1 unit of the factor's allowed unit, e.g. 1kg or 1 unit)
    // We assume 'weight' as the primary parameter for food/products.
    const estimateRes = await fetch('https://api.climatiq.io/data/v1/estimate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CLIMATIQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        emission_factor: {
          activity_id: factor.activity_id,
          data_version: "^2"
        },
        parameters: {
          // Most food activities use 'weight' or 'money'. 
          // Defaulting to 1kg if weight is a valid parameter.
          weight: 1,
          weight_unit: "kg" 
        }
      })
    });

    if (!estimateRes.ok) {
        // If estimate fails (maybe unit mismatch), we can try to return the GWP from search if it exists
        return factor.constituent_gwp ? { value: factor.constituent_gwp, source: 'Climatiq (Search)' } : null;
    }
    
    const estData = await estimateRes.json();
    return {
      value: estData.co2e || estData.total_co2e,
      source: 'Climatiq',
      factor_name: factor.name
    };
  } catch (err) {
    console.error("Climatiq Error:", err.message);
    return null;
  }
}

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
    if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
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

app.post('/api/cars/estimate-emissions', checkJwt, async (req, res) => {
  try {
    if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
      return res.status(503).json({ error: 'Emission estimates require GOOGLE_API_KEY.' });
    }
    const make = String(req.body?.make || '').trim();
    const modelName = String(req.body?.model || '').trim();
    if (!make || !modelName) {
      return res.status(400).json({ error: 'make and model are required' });
    }

    const aiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `For a carbon-tracking app, estimate kg CO2e for ONE typical short personal car trip (about 5–10 miles / 8–16 km, mixed city/highway) for this vehicle:
Make: ${make}
Model: ${modelName}

Return ONLY valid JSON (no markdown):
{"estimatedKgPerTrip": 2.4, "shortReason": "one short sentence citing fuel type/size if known"}
Use ~1.0–2.0 for BEV/small hybrid, ~2–4 for average ICE sedan, ~4–9 for large SUV/truck. Be conservative.`;

    const result = await aiModel.generateContent(prompt);
    const responseText = result.response.text();
    const cleanJson = responseText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    const kg = Math.max(0.1, Math.min(50, Number(parsed.estimatedKgPerTrip) || 2.4));
    res.json({
      estimatedKgPerTrip: kg,
      shortReason: String(parsed.shortReason || '').slice(0, 300)
    });
  } catch (err) {
    console.error('Car estimate error:', err);
    res.status(500).json({ error: err.message || 'Could not estimate emissions' });
  }
});

// POST Estimate Food Carbon (Text/Voice)
app.post('/api/food/estimate', checkJwt, async (req, res) => {
  try {
    if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
      return res.status(503).json({ error: 'AI estimates require GOOGLE_API_KEY.' });
    }
    const { description } = req.body;
    if (!description || typeof description !== 'string') {
      return res.status(400).json({ error: 'description is required' });
    }

    const aiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `For a carbon-tracking app, estimate the kg CO2e for this food item or meal: "${description}". 
    Return ONLY valid JSON (no markdown):
    {
      "label": "a short, clean name for the item",
      "value": 1.5,
      "intensity": "Low" or "High",
      "shortReason": "one short sentence explaining the footprint"
    }
    Rules: Beef/Lamb are very high (4-10+ kg), poultry/pork are medium (1-3 kg), plants/grains are low (0.1-0.8 kg).`;

    const result = await aiModel.generateContent(prompt);
    const responseText = result.response.text();
    const cleanJson = responseText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    const label = String(parsed.label || description).slice(0, 100);

    // --- CLIMATIQ ENHANCEMENT ---
    const climatiqMatch = await getClimatiqEmission(label);
    if (climatiqMatch) {
      return res.json({
        label: climatiqMatch.factor_name || label,
        value: climatiqMatch.value,
        intensity: climatiqMatch.value > 2 ? 'High' : 'Low',
        shortReason: `Verified data via ${climatiqMatch.source}.`
      });
    }
    
    res.json({
      label,
      value: Math.max(0.01, Math.min(100, Number(parsed.value) || 0.5)),
      intensity: parsed.intensity === 'High' ? 'High' : 'Low',
      shortReason: String(parsed.shortReason || 'AI estimated.').slice(0, 300)
    });
  } catch (err) {
    console.error('Food estimate error:', err);
    res.status(500).json({ error: err.message || 'Could not analyze food' });
  }
});

// POST Scan Barcode (Image analysis)
app.post('/api/food/scan-barcode', checkJwt, async (req, res) => {
  try {
    if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
      return res.status(503).json({ error: 'Barcode scanning requires GOOGLE_API_KEY.' });
    }
    const { image } = req.body;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'image (base64) is required' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const base64Data = image.includes(',') ? image.split(',')[1] : image;
    const mimeType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

    const prompt = `Identify the product from this barcode photo and estimate its typical carbon footprint (kg CO2e).
    Return ONLY valid JSON (no markdown):
    {
      "label": "Product Name",
      "value": 0.8,
      "intensity": "Low" or "High",
      "shortReason": "one short sentence"
    }
    If you cannot see a barcode or identify the product, return an error in the JSON.`;

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: base64Data, mimeType } }
    ]);
    const responseText = result.response.text();
    const cleanJson = responseText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    
    const label = String(parsed.label || 'Scanned Product').slice(0, 100);

    // --- CLIMATIQ ENHANCEMENT ---
    const climatiqMatch = await getClimatiqEmission(label);
    if (climatiqMatch) {
        return res.json({
            label: climatiqMatch.factor_name || label,
            value: climatiqMatch.value,
            intensity: climatiqMatch.value > 2 ? 'High' : 'Low',
            shortReason: `Verified barcode data via ${climatiqMatch.source}.`
        });
    }

    if (parsed.error) {
        return res.status(422).json({ error: parsed.error });
    }

    res.json({
      label,
      value: Math.max(0.01, Math.min(100, Number(parsed.value) || 1.0)),
      intensity: parsed.intensity === 'High' ? 'High' : 'Low',
      shortReason: String(parsed.shortReason || 'AI estimated.').slice(0, 300)
    });
  } catch (err) {
    console.error('Barcode scan error:', err);
    res.status(500).json({ error: err.message || 'Could not scan barcode' });
  }
});

// POST Log Activity (Protected)
app.post('/api/log', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  const { label, value, icon, intensity, carId, temporaryCar } = req.body;
  try {
    let carObjectId = null;
    const tempFlag = Boolean(temporaryCar);
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
    const items = [];
    
    for (const it of rawItems) {
      const originalLabel = (String(it?.label ?? 'Item').trim().slice(0, 200)) || 'Item';
      
      // --- CLIMATIQ ENHANCEMENT PER ITEM ---
      const climatiqMatch = await getClimatiqEmission(originalLabel);
      
      items.push({
        label: climatiqMatch ? (climatiqMatch.factor_name || originalLabel) : originalLabel,
        value: climatiqMatch ? climatiqMatch.value : Math.max(0, Number(it?.value) || 0),
        count: Math.max(1, Math.floor(Number(it?.count) || 1)),
        category:
          typeof it?.category === 'string' && it.category.trim()
            ? it.category.trim().slice(0, 80)
            : 'General',
        isVerified: !!climatiqMatch
      });
    }
    
    let totalCO2 = items.reduce((sum, row) => sum + row.value, 0);

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
        source: 'receipt',
        receiptId: newReceipt._id
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
