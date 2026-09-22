import pkg from 'pg';
import 'dotenv/config';

const { Pool } = pkg;
const isPrivateRailwayDatabase = /\.railway\.internal(?::|\/)/i.test(process.env.DATABASE_URL || '');
const productionSsl = process.env.NODE_ENV === 'production' && !isPrivateRailwayDatabase && process.env.DATABASE_SSL !== 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: productionSsl ? {
    rejectUnauthorized: true,
    ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, '\n') } : {}),
  } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export default pool;
