require('dotenv').config();
const { Pool } = require('pg');
const ssl = /neon\.tech|supabase|render\.com|sslmode=require/.test(process.env.DATABASE_URL || '')
  ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 10 });
module.exports = { pool, query: (t, p) => pool.query(t, p) };
