// index.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const authRoutes = require('./routes/auth');
const queryRoutes = require('./routes/query'); // keep your other routes
const app = express();

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/querycraft';

app.use(express.json()); // parse JSON bodies

// Basic CORS you can customize
const cors = require('cors');
app.use(cors());

app.use(express.json({ limit: '1mb' }));          // parse application/json
app.use(express.urlencoded({ extended: true }));  // parse application/x-www-form-urlencoded

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/query', queryRoutes); // existing

// Health check
app.get('/', (req, res) => res.send('QueryCraft backend is up'));

// Connect to Mongo and start
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log('Mongo connected');
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Mongo connection error:', err);
    process.exit(1);
  });
