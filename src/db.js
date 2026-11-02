require('dotenv').config();
const { Pool, types } = require('pg');
types.setTypeParser(20, v => parseInt(v, 10)); // big integers (message ids, counts) as numbers, not text
const ssl = /neon\.tech|supabase|render\.com|sslmode=require/.test(process.env.DATABASE_URL || '')
  ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 10 });
module.exports = { pool, query: (t, p) => pool.query(t, p) };
