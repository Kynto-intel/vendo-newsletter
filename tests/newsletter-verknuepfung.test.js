'use strict'
// Newsletter in Vendo per Verknüpfung (Junction): plugins/newsletter zeigt auf dieses Repository, __dirname also auf
// das Ziel. Vendos daten/ muss deshalb aus ctx.ordner kommen (Plugin-Ordner, wie Vendo ihn sieht), nicht aus __dirname.
// Nur erfundene Werte in einem Temp-Ordner, kein Netz.
//   node --test tests/newsletter-verknuepfung.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const starten = require('../haupt.js')

process.env.VENDO_TEST_HERMES_HOME ||= path.join(os.tmpdir(), 'vendo-test-ohne-hermes')

test('Protokoll wird in Vendos daten/ gelesen, abgeleitet aus ctx.ordner', (t) => {
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-newsletter-junction-'))
  t.after(() => fs.rmSync(wurzel, { recursive: true, force: true }))
  const vendo = path.join(wurzel, 'Vendo')
  const daten = path.join(vendo, 'daten', 'plugins', 'newsletter')
  fs.mkdirSync(daten, { recursive: true })
  const zeile = { zeit: '2026-11-03T10:00:00.000Z', an: 'an…@beispiel.invalid', betreff: 'Probe', art: 'test', kampagneId: null, ok: true, fehler: null }
  fs.writeFileSync(path.join(daten, 'protokoll-2026-11.ndjson'), `${JSON.stringify(zeile)}\n`)

  let gespeichert = { zugang: {}, kontakte: [], kampagnen: [], vorlagen: [], automationen: [], laeufe: [], warteschlange: [] }
  const fn = {}
  starten({
    ordner: path.join(vendo, 'plugins', 'newsletter'),
    datenLaden: () => JSON.parse(JSON.stringify(gespeichert)),
    datenSpeichern: (d) => { gespeichert = JSON.parse(JSON.stringify(d)) },
    bereitstellen: (name, f) => { fn[name] = f },
    fragen: async () => '',
    eingangOrdner: false
  })

  const liste = fn.protokollLesen({ anzahl: 10 })
  assert.equal(liste.length, 1)
  assert.equal(liste[0].betreff, 'Probe')
})
