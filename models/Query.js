const mongoose = require('mongoose');

const QuerySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  queryText: { type: String, required: true },
  responseText: { type: String },
  modelUsed: { type: String, default: 'mistral-3.5' }
}, { timestamps: true });

module.exports = mongoose.model('Query', QuerySchema);
