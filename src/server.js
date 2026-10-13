require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { checkDatabase, closeDatabase } = require('./db');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const allowedOrigins = [
  process.env.CUSTOMER_FRONTEND_URL || 'https://silent-h4x.vercel.app',
  process.env.ADMIN_FRONTEND_URL || 'https://silenth4x-admin.vercel.app',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet());

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by CORS.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '100kb' }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false
}));

app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');

    if (origin && !allowedOrigins.includes(origin)) {
      return res.status(403).json({
        success: false,
        message: 'Request origin is not allowed.'
      });
    }
  }
  next();
});

app.get('/', (req, res) => {
  res.json({
    name: 'Silent H4X Store API',
    status: 'online'
  });
});

app.get('/api/health', async (req, res) => {
  try {
    const database = await checkDatabase();
    res.json({
      success: true,
      status: 'healthy',
      database: 'connected',
      timestamp: database.server_time
    });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({
      success: false,
      status: 'unhealthy',
      database: 'disconnected'
    });
  }
});

app.use('/api/customer/auth', require('./routes/customer-auth'));
app.use('/api/admin/auth', require('./routes/admin-auth'));

app.use('/api/products', require('./routes/products'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/referrals', require('./routes/referrals'));

app.use('/api/admin/customers', require('./routes/admin-customers'));
app.use('/api/admin/payments', require('./routes/admin-payments'));
app.use('/api/admin/products', require('./routes/admin-products'));
app.use('/api/admin/wallet', require('./routes/admin-wallet'));
app.use('/api/admin/settings', require('./routes/admin-settings'));

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'API route not found.'
  });
});

app.use((err, req, res, next) => {
  console.error('Request error:', err.message);

  if (res.headersSent) return next(err);

  const status = Number(err.status) || 500;
  res.status(status >= 400 && status < 600 ? status : 500).json({
    success: false,
    message: status >= 500
      ? 'An internal server error occurred.'
      : err.message
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Silent H4X Store API listening on port ${PORT}`);
});

async function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);

  server.close(async () => {
    try {
      await closeDatabase();
      process.exit(0);
    } catch (err) {
      console.error('Shutdown error:', err.message);
      process.exit(1);
    }
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
