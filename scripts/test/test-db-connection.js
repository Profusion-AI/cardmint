#!/usr/bin/env node

/**
 * Test Fly.io Managed Postgres Connection
 * Cluster: gjpkdon11dy0yln4
 * Region: IAD
 * Postgres 16 with pooling enabled
 */

const { Pool } = require('pg');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

console.log('===================================');
console.log('Fly.io Managed Postgres Connection Test');
console.log('===================================');
console.log('Cluster ID: gjpkdon11dy0yln4');
console.log('Region: IAD (Ashburn, Virginia)');
console.log('Storage: 10GB (1.2GB Used)');
console.log('Postgres Version: 16');
console.log('Pooling: Enabled');
console.log('CPU: Shared x2');
console.log('===================================\n');

async function testConnection() {
  const DATABASE_URL = process.env.DATABASE_URL;
  
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL not found in environment variables');
    console.error('   Please ensure .env file contains DATABASE_URL');
    process.exit(1);
  }

  // Parse connection string to show details (without password)
  const urlParts = new URL(DATABASE_URL.replace('postgresql://', 'http://'));
  console.log(`Connecting to:`);
  console.log(`  Host: ${urlParts.hostname}`);
  console.log(`  Port: ${urlParts.port}`);
  console.log(`  Database: ${urlParts.pathname.slice(1)}`);
  console.log(`  User: ${urlParts.username}`);
  console.log(`  SSL Mode: ${urlParts.searchParams.get('sslmode') || 'require'}`);
  console.log('');

  // Create connection pool
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  try {
    console.log('🔄 Attempting connection...');
    
    // Test 1: Basic connectivity
    const client = await pool.connect();
    console.log('✅ Connected successfully!');

    // Test 2: Query execution
    console.log('\n🔄 Testing query execution...');
    const timeResult = await client.query('SELECT NOW() as current_time, version() as pg_version');
    console.log('✅ Query executed successfully');
    console.log(`  Server Time: ${timeResult.rows[0].current_time}`);
    console.log(`  PostgreSQL: ${timeResult.rows[0].pg_version.split(',')[0]}`);

    // Test 3: Database info
    console.log('\n🔄 Fetching database information...');
    const dbInfo = await client.query(`
      SELECT 
        current_database() as database,
        pg_database_size(current_database()) as size_bytes,
        pg_size_pretty(pg_database_size(current_database())) as size_pretty
    `);
    console.log('✅ Database info retrieved');
    console.log(`  Database: ${dbInfo.rows[0].database}`);
    console.log(`  Size: ${dbInfo.rows[0].size_pretty}`);

    // Test 4: Connection pooling info
    console.log('\n🔄 Checking connection pool...');
    const poolInfo = await client.query(`
      SELECT 
        count(*) as total_connections,
        count(*) FILTER (WHERE state = 'active') as active,
        count(*) FILTER (WHERE state = 'idle') as idle
      FROM pg_stat_activity
      WHERE datname = current_database()
    `);
    console.log('✅ Pool information retrieved');
    console.log(`  Total Connections: ${poolInfo.rows[0].total_connections}`);
    console.log(`  Active: ${poolInfo.rows[0].active}`);
    console.log(`  Idle: ${poolInfo.rows[0].idle}`);

    // Test 5: Check for Pokemon tables
    console.log('\n🔄 Checking for Pokemon tables...');
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name LIKE '%pokemon%' OR table_name LIKE '%card%'
      ORDER BY table_name
    `);
    
    if (tablesResult.rows.length > 0) {
      console.log('✅ Found Pokemon/Card tables:');
      tablesResult.rows.forEach(row => {
        console.log(`  - ${row.table_name}`);
      });
    } else {
      console.log('ℹ️ No Pokemon/Card tables found yet');
      console.log('  Run migrations to create tables');
    }

    // Test 6: Performance check
    console.log('\n🔄 Testing query performance...');
    const perfStart = Date.now();
    await client.query('SELECT 1');
    const perfTime = Date.now() - perfStart;
    console.log(`✅ Simple query latency: ${perfTime}ms`);
    
    if (perfTime < 10) {
      console.log('  Excellent latency! (< 10ms)');
    } else if (perfTime < 50) {
      console.log('  Good latency (< 50ms)');
    } else if (perfTime < 100) {
      console.log('  Acceptable latency (< 100ms)');
    } else {
      console.log('  ⚠️ High latency detected (> 100ms)');
      console.log('  Consider using connection pooling or proxy');
    }

    client.release();
    
    console.log('\n===================================');
    console.log('✅ All connection tests passed!');
    console.log('===================================');
    
    // Test proxy recommendation
    if (urlParts.hostname === '127.0.0.1' || urlParts.hostname === 'localhost') {
      console.log('\nℹ️ You are using a local proxy connection.');
      console.log('  Make sure flyctl proxy is running:');
      console.log('  flyctl proxy 16360:5432 -a cardmint-db');
    }

  } catch (error) {
    console.error('\n❌ Connection test failed!');
    console.error('Error:', error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('\n💡 Connection refused. Possible solutions:');
      console.error('  1. Start the Fly.io proxy:');
      console.error('     flyctl proxy 16360:5432 -a cardmint-db');
      console.error('  2. Check if DATABASE_URL is correct');
      console.error('  3. Verify cluster ID: gjpkdon11dy0yln4');
    } else if (error.code === 'ENOTFOUND') {
      console.error('\n💡 Host not found. Check DATABASE_URL configuration.');
    } else if (error.code === '28P01') {
      console.error('\n💡 Authentication failed. Check credentials in DATABASE_URL.');
    }
    
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run the test
testConnection().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});