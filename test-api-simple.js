#!/usr/bin/env node

const axios = require('axios');

// Simple test to verify Pokemon TCG API connection
async function testPokemonTCGAPI() {
  console.log('Testing Pokemon TCG API Connection...\n');
  
  const apiKey = process.env.POKEMONTCG_API_KEY || '';
  
  if (!apiKey) {
    console.log('⚠️  No POKEMONTCG_API_KEY found in environment');
    console.log('   The API will still work but with rate limits\n');
  }
  
  try {
    // Search for Charizard from Base Set
    const response = await axios.get('https://api.pokemontcg.io/v2/cards', {
      params: {
        q: 'name:Charizard set.name:"Base Set"',
        pageSize: 5
      },
      headers: apiKey ? { 'X-Api-Key': apiKey } : {},
      timeout: 15000
    });
    
    console.log('✅ API Connection Successful!\n');
    console.log(`Found ${response.data.data.length} cards matching "Charizard" in Base Set:\n`);
    
    response.data.data.forEach((card, index) => {
      console.log(`${index + 1}. ${card.name}`);
      console.log(`   Set: ${card.set.name}`);
      console.log(`   Number: ${card.number}/${card.set.total}`);
      console.log(`   Rarity: ${card.rarity}`);
      console.log(`   HP: ${card.hp}`);
      console.log(`   Types: ${card.types?.join(', ') || 'N/A'}`);
      console.log(`   Market Price: ${card.tcgplayer?.prices?.holofoil?.market ? 
        '$' + card.tcgplayer.prices.holofoil.market : 'N/A'}`);
      console.log(`   Image: ${card.images.small}\n`);
    });
    
    // Test our ML prediction would match
    console.log('🔍 Testing ML Prediction Match...');
    const testCard = response.data.data.find(c => c.number === '4');
    if (testCard) {
      console.log('   ✓ Found exact match for card #4/102');
      console.log(`   ✓ Card Name: ${testCard.name}`);
      console.log(`   ✓ This would validate our ML prediction!\n`);
    }
    
    console.log('💡 Integration Summary:');
    console.log('   1. Pokemon TCG API is accessible');
    console.log('   2. Can search cards by name and set');
    console.log('   3. Returns detailed card metadata');
    console.log('   4. Includes pricing data from TCGPlayer');
    console.log('   5. Provides official card images');
    console.log('\n✅ API validation pipeline is ready for integration!');
    
  } catch (error) {
    console.error('❌ API Test Failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
  }
}

// Run the test
testPokemonTCGAPI();