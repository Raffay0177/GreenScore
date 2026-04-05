import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { auth } from 'express-oauth2-jwt-bearer';
import Activity from '../server/models/Activity.js';
import UserMetric from '../server/models/UserMetric.js';
import Receipt from '../server/models/Receipt.js';
import UserCar from '../server/models/UserCar.js';
import UserElectricityProfile from '../server/models/UserElectricityProfile.js';
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

    const electricityProfile = await UserElectricityProfile.findOne({ userId }).lean();
    
    // --- ADAPTIVE AI INSIGHTS ---
    let aiTips = metrics.cachedInsights || [];
    const oneDay = 24 * 60 * 60 * 1000;
    const isStale = !metrics.lastInsightGen || (new Date() - new Date(metrics.lastInsightGen)) > oneDay;

    if (isStale || aiTips.length === 0) {
      try {
        const recentActs = activities.slice(0, 50);
        const isNewUser = activities.length < 5;
        
        let habitSummary = "";
        if (isNewUser) {
          habitSummary = "New user with very few logs. Provide high-impact generic sustainability facts popular in the US.";
        } else {
          const beefCount = recentActs.filter(a => /beef|steak|burger|cow/i.test(a.label)).length;
          const peakCarTrips = recentActs.filter(a => {
            const hour = new Date(a.timestamp).getHours();
            const isPeak = (hour >= 8 && hour <= 10) || (hour >= 16 && hour <= 18);
            return isPeak && /car/i.test(a.icon);
          }).length;
          
          habitSummary = `User habits: ${beefCount} beef-related meals, ${peakCarTrips} car trips during rush hours (8-10am, 4-6pm). 
          Electricity: ${electricityProfile ? `${electricityProfile.householdSize} people, solar: ${electricityProfile.hasSolar}` : 'Not setup'}.`;
        }

        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = `You are a sustainability expert for 'GreenScore'. Analyze these habits and provide 3 personalized, informative AI Tips.
        Rules:
        1. If user is new, give 3 generic high-impact facts for an average American.
        2. If they have high beef logs, include a specific fact about the emissions of raising one cow.
        3. If they have many rush-hour car trips, suggest taking the bus or carpooling during peak times.
        4. Be supportive and factual.
        Habit Summary: ${habitSummary}
        
        Return ONLY valid JSON (no markdown):
        [{"id": 1, "text": "Tip 1..."}, {"id": 2, "text": "Tip 2..."}, {"id": 3, "text": "Tip 3..."}]`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const cleanJson = responseText.replace(/```json|```/g, "").trim();
        aiTips = JSON.parse(cleanJson);
        
        // Cache them
        metrics.cachedInsights = aiTips;
        metrics.lastInsightGen = new Date();
        await metrics.save();
      } catch (genErr) {
        console.error("Failed to generate adaptive insights:", genErr);
        // Fallback to existing or empty if failed
        if (!aiTips.length) {
          aiTips = [
            { id: 1, text: "Try meat-free Mondays to reduce your footprint." },
            { id: 2, text: "Walking or cycling for short trips is the best way to save CO2." }
          ];
        }
      }
    }

    res.json({
      dailyGoal: metrics.dailyGoal,
      currentEmissions: metrics.currentEmissions,
      streak: metrics.streak,
      activities,
      receiptPreviews,
      electricityProfile,
      aiTips
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
Rules: estimatedKgPerTrip is highly accurate estimated kg CO2 for a typical short commute trip (3–15 mi) for the SPECIFIC make and model identified. Adjust appropriately for high-efficiency cars (e.g. Civic vs Camry) versus SUVs based on real-world MPG. BEVs ~0.5-1.5, sedans ~2.5-4, SUVs ~5-8.`;

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
{"estimatedKgPerTrip": 2.4, "shortReason": "one short sentence citing the real-world fuel economy/efficiency for this exact make and model"}
Use highly precise, real-world MPG/efficiency data for this specific vehicle model to calculate the carbon footprint of a typical ~10-mile trip. E.g. A Toyota Camry will have different emissions than a Honda Civic. BEVs: ~0.5-1.5kg, Sedans: ~2-4kg, SUVs: ~5-9kg.`;

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
    const prompt = `For a carbon-tracking app, precisely estimate the kg CO2e for this food item, meal, or product: "${description}". 
    Use highly accurate agricultural and manufacturing footprint data. Distinguish carefully between different products.
    Return ONLY valid JSON (no markdown):
    {
      "label": "a short, clean name for the item",
      "value": 1.5,
      "intensity": "Low" or "High",
      "shortReason": "one short sentence explaining the precise footprint calculation"
    }
    Rules: Beef/Lamb are very high (4-10+ kg), poultry/pork are medium (1-3 kg), plants/grains are low (0.1-0.8 kg). Provide realistic decimals.`;

    const result = await aiModel.generateContent(prompt);
    const responseText = result.response.text();
    const cleanJson = responseText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    const label = String(parsed.label || description).slice(0, 100);

    res.json({
      label,
      value: Math.max(0.01, Math.min(100, Number(parsed.value) || 0.5)),
      intensity: parsed.intensity === 'High' ? 'High' : 'Low',
      shortReason: String(parsed.shortReason || '').slice(0, 300)
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

    const prompt = `Identify the product from this barcode photo and precisely estimate its typical carbon footprint (kg CO2e).
    Use highly accurate data. Distinguish between different types of similar items based on typical manufacturing footprints.
    Return ONLY valid JSON (no markdown):
    {
      "label": "Product Name",
      "value": 0.8,
      "intensity": "Low" or "High",
      "shortReason": "one short sentence explaining the footprint derivation"
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

    if (parsed.error) {
      return res.status(422).json({ error: parsed.error });
    }

    res.json({
      label,
      value: Math.max(0.01, Math.min(100, Number(parsed.value) || 1.0)),
      intensity: parsed.intensity === 'High' ? 'High' : 'Low',
      shortReason: String(parsed.shortReason || '').slice(0, 300)
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
      Identify every food or shopping item and VERY accurately estimate its carbon footprint in kg CO2.
      Use detailed agricultural and manufacturing impact data (e.g., beef is very high, vegetables are very low, specific products vary by precise composition).
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

// --- ELECTRICITY TRACKING ---

app.post('/api/electricity/setup', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  const { householdSize, homeSize, hasSolar, solarKw, locationStr } = req.body;

  try {
    if (!process.env.GOOGLE_API_KEY) {
      return res.status(503).json({ error: 'Electricity estimates require GOOGLE_API_KEY.' });
    }

    const hSize = Math.max(1, Number(householdSize) || 1);
    const sizeStr = String(homeSize || 'Medium');
    const solar = Number(solarKw) || 0;
    const loc = String(locationStr || 'United States');

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `For a carbon-tracking app, calculate the daily electricity carbon footprint (in kg CO2e) for a household:
    Household Size: ${hSize} people
    Home Size: ${sizeStr}
    Location: ${loc}
    Solar Installed: ${hasSolar ? 'Yes' : 'No'} (${solar} kW system)
    
    Instructions:
    1. Determine the average daily electricity consumption (kWh) for a household of this size (${sizeStr}) in their location.
    2. Determine the specific grid energy mix (coal/gas/renewables percentage) for ${loc} to find the emissions per kWh.
    3. If Solar is installed, calculate the average daily generation (kWh) for a ${solar}kW system in ${loc} and subtract it from consumption. (Net can't be negative).
    
    Return ONLY JSON:
    {"dailyKgCo2e": 5.4, "shortReason": "...", "gridMix": [{"source": "Coal", "pct": 40}, ...], "solarExplanation": "..."}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const cleanJson = responseText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleanJson);
    
    const dailyKgCo2e = Math.max(0, Number(parsed.dailyKgCo2e) || 10);
    
    const profile = await UserElectricityProfile.findOneAndUpdate(
      { userId },
      {
        householdSize: hSize,
        houseSizeStr: sizeStr,
        details: JSON.stringify(parsed.gridMix || []),
        solarExplainer: String(parsed.solarExplanation || ''),
        hasSolar: Boolean(hasSolar),
        solarKw: solar,
        locationStr: loc,
        dailyKgCo2e,
        $setOnInsert: { lastAutoLoggedDate: new Date() } // start tracking from now
      },
      { new: true, upsert: true }
    );
    
    res.json({ 
      profile, 
      shortReason: parsed.shortReason, 
      gridMix: parsed.gridMix || [],
      solarExplanation: parsed.solarExplanation || ''
    });
  } catch (err) {
    console.error('Electricity setup error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/electricity/profile', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  try {
    const profile = await UserElectricityProfile.findOne({ userId });
    res.json(profile || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/electricity/sync-daily', checkJwt, async (req, res) => {
  const userId = req.auth.payload.sub;
  try {
    const profile = await UserElectricityProfile.findOne({ userId });
    if (!profile) return res.json({ syncedDays: 0 }); // none setup
    
    const now = new Date();
    const lastDate = profile.lastAutoLoggedDate;
    
    // Normalize to start of day to calculate whole days missed
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfLast = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate());
    
    const msPerDay = 1000 * 60 * 60 * 24;
    const daysMissed = Math.floor((startOfToday - startOfLast) / msPerDay);
    
    let daysSynced = 0;
    if (daysMissed > 0) {
      // Create entries for missed days
      for (let i = 1; i <= daysMissed; i++) {
        const logDate = new Date(startOfLast.getTime() + (i * msPerDay));
        // Give it a slightly random hour so they dont all stack exactly at 00:00:00
        logDate.setHours(8, 0, 0, 0); 
        
        await Activity.create({
          userId,
          label: 'Daily Home Energy',
          value: profile.dailyKgCo2e,
          icon: 'zap',
          intensity: profile.dailyKgCo2e > 20 ? 'High' : (profile.dailyKgCo2e > 8 ? 'Medium' : 'Low'),
          source: 'manual',
          timestamp: logDate
        });
        
        await UserMetric.findOneAndUpdate(
          { userId },
          { $inc: { currentEmissions: profile.dailyKgCo2e }, $set: { lastLogged: logDate } },
          { upsert: true }
        );
        daysSynced++;
      }
      
      profile.lastAutoLoggedDate = now;
      await profile.save();
    }
    
    res.json({ syncedDays: daysSynced });
  } catch (err) {
    console.error('Electricity sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default app;
