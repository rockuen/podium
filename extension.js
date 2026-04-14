// Entry point. Thin re-export — all logic lives in ./src/activation.
const { activate, deactivate } = require('./src/activation');
module.exports = { activate, deactivate };
