import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

async function testGemini() {
  const apiKey = (process.env.GOOGLE_API_KEY || '').trim();

  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    console.error('❌ ERROR: GOOGLE_API_KEY is missing or not set in .env');
    process.exit(1);
  }

  console.log(`Using API Key: ${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`);
  const genAI = new GoogleGenerativeAI(apiKey);

  try {
    console.log('\n--- Testing Model: gemini-1.5-flash ---');
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    console.log('Sending request...');
    const result = await model.generateContent("Hello! Respond with exactly: GreenScore AI is online!");
    const text = result.response.text();

    console.log('\nResponse:', text);
    console.log('\n✅ SUCCESS: Gemini 2.5 Flash is working!');
  } catch (error) {
    console.error('\n❌ API ERROR:', error.message);
  }
}

testGemini();
