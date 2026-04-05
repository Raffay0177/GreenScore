import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

async function listModels() {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  try {
    // There isn't a direct listModels in the standard SDK easily accessible without extra auth scopes sometimes
    // But we can try to hit a known one
    console.log("Checking 1.5-flash...");
    const m15 = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const r15 = await m15.generateContent("test");
    console.log("1.5-flash works!");
    
    console.log("Checking 2.0-flash...");
    const m20 = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const r20 = await m20.generateContent("test");
    console.log("2.0-flash works!");
  } catch (e) {
    console.log("Error:", e.message);
  }
}
listModels();
