'use strict'
// Electron ist in diesem Repository keine Abhängigkeit: In Vendo bringt die App es mit, hier wäre es nur für Tests
// ein Download von rund 100 MB. Tests, die den Hintergrundteil mit `safeStorage` brauchen, legen ihren Ersatz unter
// dem Schlüssel aus `electronAufloesen()` in `require.cache` ab; `require('electron')` findet ihn dann dort.

const Module = require('node:module')

const SCHLUESSEL = '\0vendo-newsletter-electron-ersatz'

function electronAufloesen() {
  if (!Module._resolveFilename.electronErsatz) {
    const original = Module._resolveFilename
    const umleiten = function (anfrage, ...rest) {
      return anfrage === 'electron' ? SCHLUESSEL : original.call(this, anfrage, ...rest)
    }
    umleiten.electronErsatz = true
    Module._resolveFilename = umleiten
  }
  return SCHLUESSEL
}

module.exports = { electronAufloesen }
