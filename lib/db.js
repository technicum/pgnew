// Shared MySQL connection pool — reused by lib/users.js and any future
// model that needs the database. Configured entirely from environment
// variables (DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME) so the
// same code runs unmodified in local dev and on the VPS — only the .env
// each machine loads is different. This does NOT create the database
// itself; DB_NAME must already exist on whichever server you point it at.
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;
