'use strict'
// Eigene Muster: `vorlagen/` enthält nur neutrale Beispiele, die eigenen Muster im Stil der eigenen Marke liegen in
// einem von Git ausgeschlossenen Ordner (`vorlagen-eigene/`). Eine gleichnamige Datei dort ersetzt das Beispiel, eine
// neue kommt dazu. Der Test lenkt den Ordner über VENDO_NEWSLETTER_EIGENE_VORLAGEN in einen Temp-Ordner.
//   node --test tests/newsletter-muster-eigene.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('eigene Muster ersetzen gleichnamige Beispiele und kommen dazu', async (t) => {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-newsletter-eigene-'))
  const alt = process.env.VENDO_NEWSLETTER_EIGENE_VORLAGEN
  t.after(() => {
    fs.rmSync(ordner, { recursive: true, force: true })
    if (alt === undefined) delete process.env.VENDO_NEWSLETTER_EIGENE_VORLAGEN
    else process.env.VENDO_NEWSLETTER_EIGENE_VORLAGEN = alt
  })
  process.env.VENDO_NEWSLETTER_EIGENE_VORLAGEN = ordner
  const muster = require('../muster.js')

  const vorher = muster.musterListe()
  assert.ok(vorher.some((m) => m.id === 'willkommen'), 'das neutrale Beispiel ist da')

  fs.writeFileSync(path.join(ordner, 'willkommen.html'), '<!-- name: Willkommen (eigene Marke) -->\n<!-- art: willkommen -->\n<p>Eigene Fassung</p>\n')
  fs.writeFileSync(path.join(ordner, 'zusatz.html'), '<!-- name: Zusatz -->\n<p>Nur lokal</p>\n')
  await new Promise((fertig) => setTimeout(fertig, 2100)) // die Muster werden höchstens alle zwei Sekunden neu gelesen

  const nachher = muster.musterListe()
  assert.equal(nachher.length, vorher.length + 1, 'eines ersetzt, eines dazu')
  assert.equal(nachher.find((m) => m.id === 'willkommen').name, 'Willkommen (eigene Marke)')
  assert.equal(muster.musterHtml('willkommen'), '<p>Eigene Fassung</p>')
  assert.equal(muster.musterHtml('zusatz'), '<p>Nur lokal</p>')
})
