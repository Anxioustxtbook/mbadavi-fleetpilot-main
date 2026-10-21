const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'jirani8741',
    database: 'fleetpilot',
    waitForConnections: true,
    connectionLimit: 10,    
    queueLimit: 0


})

module.exports = pool;