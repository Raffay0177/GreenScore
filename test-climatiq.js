import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.CLIMATIQ_API_KEY;

async function testClimatiq() {
  console.log("Checking Climatiq.io API connection...");
  console.log("Using API Key:", API_KEY ? (API_KEY.slice(0, 5) + "...") : "MISSING");

  if (!API_KEY) {
    console.error("Error: CLIMATIQ_API_KEY is not defined in .env");
    process.exit(1);
  }

  try {
    // 1. Test Search API (GET method)
    const url = new URL('https://api.climatiq.io/data/v1/search');
    url.searchParams.append('query', 'energy drink');
    url.searchParams.append('data_version', '^2');
    url.searchParams.append('results_per_page', '1');

    const searchRes = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      }
    });

    if (!searchRes.ok) {
      const errorText = await searchRes.text();
      throw new Error(`Search API failed with status ${searchRes.status}: ${errorText}`);
    }

    const searchData = await searchRes.json();
    console.log("✅ Search API response received successfully!");
    console.log("Sample Result:", searchData.results?.[0]?.name || "No results found for 'energy drink'");

    if (searchData.results && searchData.results.length > 0) {
      const factorId = searchData.results[0].activity_id;
      console.log("Testing Estimate API for activity_id:", factorId);

      // 2. Test Estimate API
      const estimateRes = await fetch('https://api.climatiq.io/data/v1/estimate', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          emission_factor: {
            activity_id: factorId,
            data_version: "^2"
          },
          parameters: {
            weight: 1,
            weight_unit: "kg"
          }
        })
      });

      if (!estimateRes.ok) {
        const errorText = await estimateRes.text();
        console.warn(`⚠️ Estimate API failed with status ${estimateRes.status}. This can happen if the factor doesn't support 'weight/kg'. Error: ${errorText}`);
      } else {
        const estData = await estimateRes.json();
        console.log("✅ Estimate API response received successfully!");
        console.log(`CO2e Estimate for 1kg of ${searchData.results[0].name}: ${estData.co2e || estData.total_co2e} ${estData.co2e_unit}`);
      }
    }

    console.log("\n🚀 Climatiq.io API is communicating perfectly!");

  } catch (err) {
    console.error("\n❌ Climatiq.io API communication failed:");
    console.error(err.message);
  }
}

testClimatiq();
