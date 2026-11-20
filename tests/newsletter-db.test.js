'use strict'
// Newsletter, Schritt N2 des PostgreSQL-Umbaus: Schema und Migrationen. Läuft gegen die Test-Datenbank in einem eigenen
// Schema, nie gegen die echte. Ohne erreichbare Test-Datenbank werden die Datenbank-Tests übersprungen.
//   node --test tests/newsletter-db.test.js

const test = require('node:test')
const assert = require('node:assert/strict')
const { migrationen, schemaPruefen, SCHEMA, TABELLEN } = require('../db.js')
const { testDatenbank } = require('./hilfen/test-datenbank.cjs')

test('Schemaname: nur einfache Namen, Standard ist die Plugin-ID', () => {
  assert.equal(SCHEMA, 'newsletter')
  assert.throws(() => schemaPruefen('newsletter; DROP SCHEMA vendo'), /Ungültiger Schemaname/)
  assert.throws(() => migrationen('Gross'), /Ungültiger Schemaname/)
  assert.match(migrationen()[0].sql, /CREATE SCHEMA IF NOT EXISTS newsletter;/)
})

test('Datenbank: leere Datenbank durchläuft alle Migrationen, ein zweiter Lauf legt nichts doppelt an', async (t) => {
  const db = await testDatenbank('db')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())

  const erst = await db.datenbank.migrieren(migrationen(db.schema))
  assert.deepEqual(erst, { vorher: 0, jetzt: 1 })
  const zweit = await db.datenbank.migrieren(migrationen(db.schema))
  assert.deepEqual(zweit, { vorher: 1, jetzt: 1 }, 'nichts mehr offen')
  // Auch ein erzwungener zweiter Lauf derselben SQL scheitert nicht (IF NOT EXISTS überall)
  await db.roh(migrationen(db.schema)[0].sql)

  const tabellen = (await db.roh('SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1', [db.schema])).rows.map((r) => r.table_name)
  assert.deepEqual(tabellen, ['automationen', 'einstellungen', 'ergebnis_bestellungen', 'ergebnis_namen', 'kampagnen', 'kontakte', 'laeufe', 'protokoll', 'ruecklaeufer', 'vorlagen', 'warteschlange'])

  // Jede Listentabelle hat die gemeinsamen Spalten und die abgeleiteten Spalten aus db.js
  for (const [name, def] of Object.entries(TABELLEN)) {
    const spalten = (await db.roh('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [db.schema, name])).rows.map((r) => r.column_name)
    for (const s of ['schluessel', 'position', 'daten', 'geaendert_am', ...Object.keys(def.spalten)]) assert.ok(spalten.includes(s), `${name}.${s} fehlt`)
  }
  const indizes = (await db.roh('SELECT indexname FROM pg_indexes WHERE schemaname = $1', [db.schema])).rows.map((r) => r.indexname)
  for (const i of ['warteschlange_faellig', 'kontakte_gesperrt', 'protokoll_zeit', 'protokoll_kampagne', 'laeufe_lauf_schluessel']) assert.ok(indizes.includes(i), `Index ${i} fehlt`)
})
