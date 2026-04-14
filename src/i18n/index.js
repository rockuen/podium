// @module i18n — Runtime locale resolution and translation lookup.
// Loads per-locale strings from ./en and ./ko. Falls back to English for missing keys.

const vscode = require('vscode');

const LOCALES = {
  en: require('./en'),
  ko: require('./ko'),
};

function getLocale() {
  const lang = vscode.env.language || 'en';
  return lang.startsWith('ko') ? 'ko' : 'en';
}

function t(key) {
  const locale = getLocale();
  return LOCALES[locale]?.[key] || LOCALES.en[key] || key;
}

// Returns the entire strings object for the current locale.
// Used when passing translations to the webview in one shot.
function getTranslations() {
  return LOCALES[getLocale()] || LOCALES.en;
}

module.exports = { LOCALES, getLocale, t, getTranslations };
