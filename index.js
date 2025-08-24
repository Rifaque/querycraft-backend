/**
 * QueryCraft - Simple Express backend (no TypeScript)
 * - Auth routes: /auth/register, /auth/login
 * - Query route: /query (POST)
 * - Uses Mongoose for MongoDB
 */

const express = require('express');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const queryRoutes = require('./routes/query');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// routes
app.use('/auth', authRoutes);
app.use('/query', queryRoutes);

// health
app.get('/', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'dev' }));

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/querycraft';

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => console.log('Server running on port', PORT));
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
