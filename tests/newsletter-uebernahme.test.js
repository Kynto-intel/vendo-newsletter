// Newsletter, Schritt N4 des PostgreSQL-Umbaus: Übernahme aus dem Plugin-Speicher und den Protokolldateien in die
// eigenen Tabellen. Gegen die Test-Datenbank (eigenes Schema je Test, nie die echte Datenbank), alle Daten erfunden.
// Ohne erreichbare Test-Datenbank werden die Tests übersprungen.
//   node --test tests/newsletter-uebernahme.test.js

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { electronAufloesen } from './hilfen/electron-ersatz.cjs'
import { testDatenbank } from './hilfen/test-datenbank.cjs'

process.env.VENDO_TEST_HERMES_HOME ||= path.join(os.tmpdir(), 'vendo-test-ohne-hermes')

const require = createRequire(import.meta.url)
const ersatz = (pfad, exports) => { require.cache[pfad] = { id: pfad, filename: pfad, loaded: true, exports } }
ersatz(electronAufloesen(), {
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (x) => Buffer.from(`test:${x}`), decryptString: (b) => Buffer.from(b).toString().slice(5) }
})
ersatz(require.resolve('nodemailer'), { createTransport: () => ({ sendMail: async () => ({ messageId: 'x' }), close() {} }) })
const { default: starten } = await import('../haupt.js')

const kontakt = (email, extra = {}) => ({ email, vorname: 'Anna', nachname: '', quelle: 'shopify', zustand: 'SUBSCRIBED', zustimmungAm: '2026-01-01', gesperrt: false, ...extra })
const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `vendo-newsletter-${name}-`))

function bestand(extra = {}) {
  return {
    zugang: { benutzer: 'info@beispiel.invalid', passwortVerschluesselt: Buffer.from('test:nur-ein-test-passwort').toString('base64') },
    marke: { titel: 'Beispielshop', impressum: 'Beispielshop, Musterweg 1', abmeldeAdresse: 'abmelden@beispiel.invalid', farben: {} },
    shopify: { shop: 'beispielshop.myshopify.com' },
    einstellungen: { budgetProStunde: 300 },
    drossel: { gesendet: [] },
    kontakte: [kontakt('a@beispiel.invalid'), kontakt('b@beispiel.invalid', { gesperrt: true, sperrArt: 'beschwerde' }), kontakt('c@beispiel.invalid')],
    kampagnen: [{ id: 'k1', name: 'Fertig', zustand: 'fertig', utm: 'fertig' }, { id: 'k2', name: 'Entwurf', zustand: 'entwurf' }],
    vorlagen: [],
    automationen: [{ id: 'a1', name: 'Willkommen', ausloeser: 'willkommen', aktiv: true, schritte: [] }],
    laeufe: [],
    warteschlange: [{ id: 'w1', schluessel: 'k1:a@beispiel.invalid', kampagneId: 'k1', an: 'a@beispiel.invalid', art: 'kampagne', zustand: 'gesendet', faelligAb: 1763600000000, versuche: 1 }],
    ruecklaeufer: [],
    ergebnisse: { geholtAm: 1763600000000, namen: { fertig: { art: 'kampagne', id: 'k1', seit: 1763500000000 } }, bestellungen: [{ id: 'o1', kurz: 'fertig', betrag: 24.95, waehrung: 'EUR', am: 1763600000000 }] },
    ...extra
  }
}

// Zwei Monatsdateien mit Protokollzeilen, wie protokoll.js sie schreibt (Adressen gekürzt)
function protokollDateien(ordner) {
  const zeile = (zeit, betreff, ok = true) => JSON.stringify({ zeit, an: 'a***@beispiel.invalid', betreff, art: 'kampagne', kampagneId: 'k1', ok, fehler: ok ? null : '550' })
  fs.writeFileSync(path.join(ordner, 'protokoll-2026-10.ndjson'), [zeile('2026-10-02T08:00:00.000Z', 'Oktober 1'), zeile('2026-10-03T08:00:00.000Z', 'Oktober 2', false)].join('\n') + '\n')
  fs.writeFileSync(path.join(ordner, 'protokoll-2026-11.ndjson'), zeile('2026-11-04T08:00:00.000Z', 'November') + '\n')
}

function hauptStarten(db, { daten = bestand(), datenbank = db.datenbank } = {}) {
  let gespeichert = JSON.parse(JSON.stringify(daten))
  let pluginSchreibvorgaenge = 0
  const protokollOrdner = temp('protokoll')
  protokollDateien(protokollOrdner)
  const sicherungOrdner = temp('sicherung')
  const fn = {}
  starten({
    datenLaden: () => JSON.parse(JSON.stringify(gespeichert)),
    datenSpeichern: (d) => { pluginSchreibvorgaenge++; gespeichert = JSON.parse(JSON.stringify(d)) },
    festschreiben: async () => {},
    datenbank,
    speicherSchema: db.schema,
    journalDatei: path.join(temp('journal'), 'tabellen-journal.json'),
    sicherungOrdner,
    protokollOrdner,
    bereitstellen: (name, f) => { fn[name] = f },
    fragen: async () => '',
    eingangOrdner: false,
    abrufen: async () => ({ ok: false, status: 500, json: async () => ({}) })
  })
  return { fn, plugin: () => gespeichert, schreibvorgaenge: () => pluginSchreibvorgaenge, sicherungOrdner }
}

const anzahl = async (db, tabelle) => (await db.roh(`SELECT count(*)::int AS n FROM ${db.schema}.${tabelle}`)).rows[0].n

test('Übernahme: alles kopiert, abgeglichen, Sicherung angelegt, danach läuft alles über die Tabellen', async (t) => {
  const db = await testDatenbank('uebernahme')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())
  const h = hauptStarten(db)
  assert.equal(h.fn.speicherZustand().modus, 'plugin')

  // Ein Aufruf während der Übernahme wartet und sieht danach denselben Stand
  const laeuft = h.fn.tabellenUebernehmen()
  const waehrenddessen = h.fn.uebersichtLesen()
  assert.equal(typeof waehrenddessen?.then, 'function', 'der Aufruf wartet auf das Ende der Übernahme')
  const r = await laeuft
  assert.equal(r.ok, true, r.text)
  assert.deepEqual(await waehrenddessen, { kampagnen: 2, geplantOderLaufend: 0, freigaben: 0, automationenAktiv: 1 })
  assert.deepEqual(r.zaehlung, { kontakte: 3, gesperrt: 1, kampagnen: 2, vorlagen: 0, automationen: 1, laeufe: 0, warteschlange: 1, ruecklaeufer: 0, bestellungen: 1, protokoll: 3 })

  // Plugin-Speicher trägt nur noch die Markierung; die Sicherung enthält den alten Stand
  const plugin = h.plugin()
  assert.deepEqual(Object.keys(plugin), ['_speicher'])
  assert.equal(plugin._speicher.modus, 'tabellen')
  const sicherung = JSON.parse(fs.readFileSync(path.join(h.sicherungOrdner, plugin._speicher.sicherung), 'utf8'))
  assert.equal(sicherung.stand.kontakte.length, 3)
  assert.equal(sicherung.protokoll.length, 3)

  assert.equal(await anzahl(db, 'kontakte'), 3)
  assert.equal(await anzahl(db, 'protokoll'), 3)
  assert.deepEqual(h.fn.protokollLesen({ anzahl: 10 }).map((z) => z.betreff), ['November', 'Oktober 2', 'Oktober 1'])
  assert.equal(h.fn.speicherZustand().modus, 'tabellen')

  // Ab jetzt landet jede Änderung in den Tabellen, der Plugin-Speicher bleibt unberührt
  const vorher = h.schreibvorgaenge()
  const sperre = await h.fn.kontaktSperren({ email: 'c@beispiel.invalid' })
  assert.equal(sperre.ok, true, JSON.stringify(sperre))
  assert.equal((await db.roh(`SELECT gesperrt FROM ${db.schema}.kontakte WHERE schluessel = 'c@beispiel.invalid'`)).rows[0].gesperrt, true)
  assert.equal(h.schreibvorgaenge(), vorher)

  const zweimal = await h.fn.tabellenUebernehmen()
  assert.equal(zweimal.ok, false)
  assert.match(zweimal.text, /schon in den Datenbank-Tabellen/)
})

test('Übernahme: nicht während einer laufenden Kampagne oder mit offener Warteschlange', async (t) => {
  const db = await testDatenbank('hindernis')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())
  const laufend = hauptStarten(db, { daten: bestand({ kampagnen: [{ id: 'k9', name: 'Läuft', zustand: 'laeuft' }] }) })
  const r = await laufend.fn.tabellenUebernehmen()
  assert.equal(r.ok, false)
  assert.match(r.text, /keine Kampagne mehr läuft/)
  assert.equal(laufend.plugin().kontakte.length, 3, 'Plugin-Speicher unverändert')
  assert.deepEqual(fs.readdirSync(laufend.sicherungOrdner), [], 'keine Sicherung, nichts angefangen')

  const offen = hauptStarten(db, { daten: bestand({ warteschlange: [{ id: 'w2', schluessel: 'x', an: 'a@beispiel.invalid', art: 'test', zustand: 'offen', faelligAb: 0, versuche: 0 }] }) })
  const r2 = await offen.fn.tabellenUebernehmen()
  assert.equal(r2.ok, false)
  assert.match(r2.text, /Warteschlange leer/)
})

test('Übernahme: in Tabellen mit Daten wird nichts geschrieben', async (t) => {
  const db = await testDatenbank('belegt')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())
  const { migrationen } = require('../db.js')
  await db.datenbank.migrieren(migrationen(db.schema))
  await db.roh(`INSERT INTO ${db.schema}.kampagnen (schluessel, position, daten) VALUES ('fremd', 0, '{"id":"fremd"}')`)
  const h = hauptStarten(db)
  const r = await h.fn.tabellenUebernehmen()
  assert.equal(r.ok, false)
  assert.match(r.text, /schon Daten/)
  assert.equal(await anzahl(db, 'kampagnen'), 1, 'die fremde Zeile ist unberührt')
  assert.equal(h.plugin().kontakte.length, 3)
  assert.equal(h.fn.speicherZustand().modus, 'plugin')
})

test('Übernahme: scheitert das Schreiben, werden die Tabellen geleert, und es bleibt beim Plugin-Speicher', async (t) => {
  const db = await testDatenbank('fehler')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())
  const brechend = {
    ...db.datenbank,
    transaktion: (arbeit) => db.datenbank.transaktion((c) => arbeit({
      query: async (sql, werte) => {
        if (/INSERT INTO \S+\.protokoll/.test(sql)) throw new Error('Verbindung verloren')
        return c.query(sql, werte)
      }
    }))
  }
  const h = hauptStarten(db, { datenbank: brechend })
  const r = await h.fn.tabellenUebernehmen()
  assert.equal(r.ok, false)
  assert.match(r.text, /abgebrochen.*Verbindung verloren/)
  for (const tabelle of ['kontakte', 'kampagnen', 'einstellungen', 'protokoll']) assert.equal(await anzahl(db, tabelle), 0, `${tabelle} leer`)
  assert.equal(h.plugin().kontakte.length, 3, 'Plugin-Speicher unverändert')
  assert.equal(h.fn.speicherZustand().modus, 'plugin')
  // Der Betrieb geht normal weiter
  const sperre = await h.fn.kontaktSperren({ email: 'a@beispiel.invalid' })
  assert.equal(sperre.ok, true)
  assert.equal(h.plugin().kontakte.find((k) => k.email === 'a@beispiel.invalid').gesperrt, true)
})

test('Übernahme: stimmt der Abgleich nach dem Kopieren nicht, wird nicht umgeschaltet', async (t) => {
  const db = await testDatenbank('abgleich')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())
  let lesevorgaenge = 0
  const verfaelschend = {
    ...db.datenbank,
    // Das Zurücklesen (zweites Laden der Kontakte) verliert einen Kontakt
    abfrage: async (sql, werte) => {
      const r = await db.datenbank.abfrage(sql, werte)
      if (/FROM \S+\.kontakte ORDER BY/.test(sql) && ++lesevorgaenge === 2) return { ...r, rows: r.rows.slice(1) }
      return r
    }
  }
  const h = hauptStarten(db, { datenbank: verfaelschend })
  const r = await h.fn.tabellenUebernehmen()
  assert.equal(r.ok, false)
  assert.match(r.text, /Abgleich/)
  assert.equal(r.soll.kontakte, 3)
  assert.equal(r.ist.kontakte, 2)
  assert.equal(await anzahl(db, 'kontakte'), 0, 'Tabellen wieder geleert')
  assert.equal(h.plugin().kontakte.length, 3)
  assert.equal(h.fn.speicherZustand().modus, 'plugin')
})
