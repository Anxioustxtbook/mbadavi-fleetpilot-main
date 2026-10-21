import mysql from 'mysql2/promise';
import 'dotenv/config';

export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'fleetpilot',
  waitForConnections: true,
  connectionLimit: 8,
  dateStrings: true,          // DATE/TIME come back as 'YYYY-MM-DD' / 'HH:MM:SS' strings
  decimalNumbers: true,       // DECIMAL comes back as JS numbers
  charset: 'utf8mb4'
});
