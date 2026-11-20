// Newsletter, Schritt N3 des PostgreSQL-Umbaus: Speicher auf eigenen Tabellen. Zerlegen und Vergleichen ohne
// Datenbank; Hin- und Rückweg, Schreiben nur geänderter Zeilen, Ausfall mit Journal, Neustart, Protokoll und der
// Hintergrundteil im Tabellenbetrieb gegen die Test-Datenbank (eigenes Schema je Test, nie die echte Datenbank).
// Ohne erreichbare Test-Datenbank werden die Datenbank-Tests übersprungen. Alle Daten erfunden.
//   node --test tests/newsletter-speicher-tabellen.test.js

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { electronAufloesen } from './hilfen/electron-ersatz.cjs'
import { testDatenbank } from './hilfen/test-datenbank.cjs'
import tabellen from '../speicher-tabellen.js'
import speicherModul from '../speicher.js'
import ws from '../warteschlange.js'

process.env.VENDO_TEST_HERMES_HOME ||= path.join(os.tmpdir(), 'vendo-test-ohne-hermes')
const { tabellenSpeicherMachen, zerlegen, unterschied } = tabellen
const { vervollstaendigen, modusVon } = speicherModul

const kontakt = (email, extra = {}) => ({ email, vorname: 'Anna', nachname: '', quelle: 'shopify', zustand: 'SUBSCRIBED', zustimmungAm: '2026-01-01', gesperrt: false, ...extra })

// Ein Stand mit allem, was vorkommt: Listen mit und ohne Kennung, doppelte Adresse, Ergebnisse, unbekannter Schlüssel
const STAND = {
  zugang: { benutzer: 'info@beispiel.invalid', host: 'smtp.beispiel.invalid', port: 465 },
  shopify: { shop: 'beispielshop.myshopify.com', primaerDomain: 'beispiel-shop.de' },
  marke: { titel: 'Beispielshop', farben: { akzent: '#C29A40' } },
  einstellungen: { budgetProStunde: 300, ruecklaeufer: { aktiv: true, ordner: 'Ruecklaeufer' } },
  drossel: { gesendet: [1763600000000, 1763600012000], pauseBis: 0 },
  kontakte: [kontakt('a@beispiel.invalid', { shopifyId: 'gid://shopify/Customer/1' }), kontakt('b@beispiel.invalid', { gesperrt: true, sperrArt: 'ruecklaeufer' }), kontakt('A@beispiel.invalid')],
  kampagnen: [{ id: 'k1', name: 'Neu im Shop', zustand: 'entwurf', html: '<p>Hallo {{vorname}}</p>', utm: null }, { id: 'k2', name: 'Zweite', zustand: 'fertig', utm: 'zweite' }],
  vorlagen: [{ id: 'v1', name: 'Eigene', html: '<p>x</p>' }],
  automationen: [{ id: 'a1', name: 'Willkommen', ausloeser: 'willkommen', aktiv: true, schritte: [{ nach: 3600000, betreff: 'Hallo', html: '' }] }],
  laeufe: [{ id: 'l1', schluessel: 'a1:a@beispiel.invalid', automationId: 'a1', email: 'a@beispiel.invalid', zustand: 'laeuft', schritt: 0 }],
  warteschlange: [{ id: 'w1', schluessel: 'k2:a@beispiel.invalid', kampagneId: 'k2', an: 'a@beispiel.invalid', art: 'kampagne', zustand: 'gesendet', faelligAb: 1763600000000, versuche: 1 }],
  ruecklaeufer: [{ am: 1763600000000, email: 'b@beispiel.invalid', art: 'hart', status: '5.1.1', grund: 'unbekannt', quelle: null }, { am: 1763600000000, email: 'b@beispiel.invalid', art: 'hart', status: '5.1.1', grund: 'unbekannt', quelle: null }],
  ergebnisse: { geholtAm: 1763600000000, namen: { zweite: { art: 'kampagne', id: 'k2', seit: 1763500000000 } }, bestellungen: [{ id: 'o1', kurz: 'zweite', betrag: 59.99, waehrung: 'EUR', am: 1763600000000 }] },
  botStand: { stand: 7, zuletzt: [{ id: 'k1', von: 'Texterin' }] }
}

// ── ohne Datenbank ──

test('zerlegen: Schlüssel aus dem Objekt, fehlend oder doppelt aus der Position', () => {
  const z = zerlegen(STAND)
  assert.deepEqual([...z.listen.kontakte.keys()], ['a@beispiel.invalid', 'b@beispiel.invalid', '@2'], 'zweite Schreibweise derselben Adresse')
  assert.deepEqual([...z.listen.ruecklaeufer.keys()], ['@0', '@1'], 'Rückläufer haben keine Kennung')
  assert.equal(z.listen.kontakte.get('b@beispiel.invalid').spalten.gesperrt, true)
  assert.equal(z.listen.warteschlange.get('w1').spalten.faellig_ab, 1763600000000)
  assert.deepEqual([...z.listen.ergebnis_bestellungen.keys()], ['o1'])
  assert.deepEqual([...z.namen.keys()], ['zweite'])
  assert.deepEqual([...z.einstellungen.keys()].sort(), ['botStand', 'drossel', 'einstellungen', 'ergebnisse', 'marke', 'shopify', 'zugang'])
  assert.deepEqual(JSON.parse(z.einstellungen.get('ergebnisse')), { geholtAm: 1763600000000 }, 'namen und bestellungen haben eigene Tabellen')
})

test('unterschied: nur geänderte, verschobene und gelöschte Zeilen', () => {
  const alt = zerlegen(STAND)
  assert.equal(unterschied(alt, zerlegen(STAND)).leer, true)
  const neu = JSON.parse(JSON.stringify(STAND))
  neu.kontakte[0].gesperrt = true
  neu.kampagnen = [neu.kampagnen[1]] // k1 gelöscht, k2 rückt nach vorn
  delete neu.botStand
  const p = unterschied(alt, zerlegen(neu))
  assert.deepEqual(p.listen.kontakte.schreiben.map((z) => z.schluessel), ['a@beispiel.invalid'])
  assert.deepEqual(p.listen.kampagnen.schreiben.map((z) => z.schluessel), ['k2'], 'neue Position')
  assert.deepEqual(p.listen.kampagnen.loeschen, ['k1'])
  assert.deepEqual(p.einstellungen.loeschen, ['botStand'])
  assert.equal(p.listen.automationen.schreiben.length + p.listen.automationen.loeschen.length, 0)
})

test('Speicherwahl: Tabellen nur mit der Markierung der Übernahme', () => {
  assert.equal(modusVon({ kontakte: [] }), 'plugin')
  assert.equal(modusVon(null), 'plugin')
  assert.equal(modusVon({ _speicher: { modus: 'tabellen' } }), 'tabellen')
  assert.equal('_speicher' in vervollstaendigen({ _speicher: { modus: 'tabellen' } }), false, 'die Markierung sieht der Rest nie')
})

// ── gegen die Test-Datenbank ──

const tempDatei = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-newsletter-journal-')), name)

// Alle SQL-Aufrufe einer Transaktion mitschreiben
function mitschreiben(datenbank) {
  const aufrufe = []
  return {
    aufrufe,
    datenbank: {
      ...datenbank,
      transaktion: (arbeit) => datenbank.transaktion((c) => arbeit({ query: (sql, werte) => { aufrufe.push({ sql, werte }); return c.query(sql, werte) } }))
    }
  }
}

test('Datenbank: Hin- und Rückweg ohne Verlust, auch nach einem Neustart', async (t) => {
  const db = await testDatenbank('rundweg')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())

  const erst = tabellenSpeicherMachen({ datenbank: db.datenbank, schema: db.schema, journalDatei: tempDatei('j.json') })
  await erst.laden()
  assert.deepEqual(vervollstaendigen(erst.lesen()).kontakte, [], 'leere Tabellen: leerer Stand')
  erst.speichern(STAND)
  await erst.festschreiben()

  const zweit = tabellenSpeicherMachen({ datenbank: db.datenbank, schema: db.schema, journalDatei: tempDatei('j.json') })
  await zweit.laden()
  assert.deepEqual(zweit.lesen(), STAND)
  const zeilen = (await db.roh(`SELECT schluessel, gesperrt, shopify_id FROM ${db.schema}.kontakte ORDER BY position`)).rows
  assert.deepEqual(zeilen, [
    { schluessel: 'a@beispiel.invalid', gesperrt: false, shopify_id: 'gid://shopify/Customer/1' },
    { schluessel: 'b@beispiel.invalid', gesperrt: true, shopify_id: null },
    { schluessel: '@2', gesperrt: false, shopify_id: null }
  ])
})

test('Datenbank: geschrieben werden nur geänderte Zeilen, alles in einer Transaktion', async (t) => {
  const db = await testDatenbank('aenderung')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())
  const spion = mitschreiben(db.datenbank)
  const s = tabellenSpeicherMachen({ datenbank: spion.datenbank, schema: db.schema, journalDatei: tempDatei('j.json') })
  await s.laden()
  s.speichern(STAND)
  await s.festschreiben()

  spion.aufrufe.length = 0
  const d = s.lesen()
  d.kontakte[1].gesperrtGrund = 'Rückläufer'
  s.speichern(d)
  const d2 = s.lesen()
  d2.marke.titel = 'Beispielshop Neu'
  s.speichern(d2) // zwei Speichervorgänge kurz hintereinander: ein Durchgang
  await s.festschreiben()
  const schreibend = spion.aufrufe.filter((a) => /^\s*(INSERT|DELETE|UPDATE)/i.test(a.sql))
  assert.equal(schreibend.length, 2, schreibend.map((a) => a.sql.slice(0, 40)).join(' | '))
  assert.match(schreibend[0].sql, /INSERT INTO \S+\.kontakte/)
  assert.equal(JSON.parse(schreibend[0].werte[0]).length, 1, 'genau ein Kontakt')
  assert.match(schreibend[1].sql, /INSERT INTO \S+\.einstellungen/)
  assert.equal(schreibend[1].werte[0], 'marke')
})

test('Datenbank fällt aus: Stand ins Journal, Tabellen unverändert, später nachgeschrieben', async (t) => {
  const db = await testDatenbank('ausfall')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())
  const journal = tempDatei('j.json')
  const s = tabellenSpeicherMachen({ datenbank: db.datenbank, schema: db.schema, journalDatei: journal })
  await s.laden()
  s.speichern(STAND)
  await s.festschreiben()

  db.abschalten()
  const d = s.lesen()
  d.kampagnen.push({ id: 'k3', name: 'Im Ausfall angelegt', zustand: 'entwurf' })
  s.speichern(d)
  await assert.rejects(() => s.festschreiben(), /nicht bereit/)
  assert.equal(s.zustand().offen, true)
  assert.ok(fs.existsSync(journal), 'Journal geschrieben')
  db.einschalten()
  assert.equal((await db.roh(`SELECT count(*)::int AS n FROM ${db.schema}.kampagnen`)).rows[0].n, 2, 'nichts halb geschrieben')

  await s.festschreiben()
  assert.equal((await db.roh(`SELECT count(*)::int AS n FROM ${db.schema}.kampagnen`)).rows[0].n, 3)
  assert.equal(fs.existsSync(journal), false, 'Journal nach dem Nachschreiben gelöscht')
  assert.equal(s.zustand().offen, false)
})

test('Abbruch mitten im Schreiben: die Transaktion hinterlässt nichts Halbes', async (t) => {
  const db = await testDatenbank('abbruch')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())
  let abbrechen = false
  const brechend = {
    ...db.datenbank,
    transaktion: (arbeit) => db.datenbank.transaktion(async (c) => arbeit({
      query: async (sql, werte) => {
        if (abbrechen && /einstellungen/.test(sql)) throw new Error('Verbindung mitten im Schreiben verloren')
        return c.query(sql, werte)
      }
    }))
  }
  const s = tabellenSpeicherMachen({ datenbank: brechend, schema: db.schema, journalDatei: tempDatei('j.json') })
  await s.laden()
  s.speichern(STAND)
  await s.festschreiben()
  abbrechen = true
  const d = s.lesen()
  d.kontakte = d.kontakte.slice(0, 1) // Kontakte werden vor den Einstellungen geschrieben
  d.marke.titel = 'Nie angekommen'
  s.speichern(d)
  await assert.rejects(() => s.festschreiben(), /mitten im Schreiben/)
  assert.equal((await db.roh(`SELECT count(*)::int AS n FROM ${db.schema}.kontakte`)).rows[0].n, 3, 'Löschen der Kontakte zurückgerollt')
  abbrechen = false
  await s.festschreiben()
  assert.equal((await db.roh(`SELECT count(*)::int AS n FROM ${db.schema}.kontakte`)).rows[0].n, 1)
})

test('Neustart nach Ausfall: das Journal gilt vor den Tabellen und wird nachgeschrieben', async (t) => {
  const db = await testDatenbank('journal')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())
  const journal = tempDatei('j.json')
  const vorher = tabellenSpeicherMachen({ datenbank: db.datenbank, schema: db.schema, journalDatei: journal })
  await vorher.laden()
  vorher.speichern(STAND)
  await vorher.festschreiben()
  db.abschalten()
  const d = vorher.lesen()
  d.kontakte[0].gesperrt = true
  vorher.speichern(d)
  vorher.protokollSchreiben({ an: 'a@beispiel.invalid', betreff: 'Vor dem Absturz', ok: true, zeit: new Date('2026-11-20T09:00:00Z') })
  await vorher.festschreiben().catch(() => {})
  db.einschalten()
  // „Absturz“: der alte Speicher ist weg, ein neuer startet
  const nachher = tabellenSpeicherMachen({ datenbank: db.datenbank, schema: db.schema, journalDatei: journal })
  await nachher.laden()
  assert.equal(nachher.lesen().kontakte[0].gesperrt, true, 'die Sperre aus dem Journal gilt')
  await nachher.festschreiben()
  assert.equal((await db.roh(`SELECT gesperrt FROM ${db.schema}.kontakte WHERE schluessel = 'a@beispiel.invalid'`)).rows[0].gesperrt, true)
  assert.equal((await db.roh(`SELECT count(*)::int AS n FROM ${db.schema}.protokoll`)).rows[0].n, 1, 'die Protokollzeile ist nachgeschrieben')
  assert.equal(fs.existsSync(journal), false)
})

test('Protokoll: eine Zeile je Mail in der Tabelle, neueste zuerst gelesen', async (t) => {
  const db = await testDatenbank('protokoll')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())
  const s = tabellenSpeicherMachen({ datenbank: db.datenbank, schema: db.schema, journalDatei: tempDatei('j.json') })
  await s.laden()
  for (const [i, ok] of [[1, true], [2, false], [3, true]]) {
    s.protokollSchreiben({ an: `kunde${i}@beispiel.invalid`, betreff: `Mail ${i}`, art: 'kampagne', kampagneId: 'k1', ok, fehler: ok ? null : '550', zeit: new Date(`2026-11-20T10:0${i}:00Z`) })
  }
  await s.festschreiben()
  const zeilen = (await db.roh(`SELECT an_adresse, ok, kampagne_id FROM ${db.schema}.protokoll ORDER BY id`)).rows
  assert.equal(zeilen.length, 3)
  assert.match(zeilen[0].an_adresse, /^k\*\*\*@/, 'Adressen nur gekürzt, wie in den Monatsdateien')
  const neu = tabellenSpeicherMachen({ datenbank: db.datenbank, schema: db.schema, journalDatei: tempDatei('j.json') })
  await neu.laden()
  const gelesen = neu.protokollLesen({ anzahl: 2 })
  assert.deepEqual(gelesen.map((z) => z.betreff), ['Mail 3', 'Mail 2'])
  assert.equal(gelesen[1].ok, false)
  assert.equal(gelesen[0].zeit, '2026-11-20T10:03:00.000Z')
})

// ── Hintergrundteil im Tabellenbetrieb ──

const require = createRequire(import.meta.url)
const ersatz = (pfad, exports) => { require.cache[pfad] = { id: pfad, filename: pfad, loaded: true, exports } }
ersatz(electronAufloesen(), {
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (x) => Buffer.from(`test:${x}`), decryptString: (b) => Buffer.from(b).toString().slice(5) }
})
const gesendet = []
ersatz(require.resolve('nodemailer'), { createTransport: () => ({ sendMail: async (mail) => { gesendet.push(mail.to); return { messageId: 'x' } }, close() {} }) })
const { default: starten } = await import('../haupt.js')

test('haupt.js im Tabellenbetrieb: Aufrufe warten aufs Laden, Versand und Sperre landen in den Tabellen', async (t) => {
  const db = await testDatenbank('haupt')
  if (!db) return t.skip('Test-Datenbank nicht erreichbar')
  t.after(() => db.schliessen())
  // Vorher liegen die Daten schon in den Tabellen (wie nach der Übernahme in Schritt N4)
  const vorbereiten = tabellenSpeicherMachen({ datenbank: db.datenbank, schema: db.schema, journalDatei: tempDatei('j.json') })
  await vorbereiten.laden()
  const [eintrag] = ws.einreihen([], [{ an: 'info@beispiel.invalid', betreff: 'Probe', html: '<p>x</p>', art: 'test' }]).liste
  vorbereiten.speichern({
    ...STAND,
    zugang: { benutzer: 'info@beispiel.invalid', passwortVerschluesselt: Buffer.from('test:nur-ein-test-passwort').toString('base64') },
    marke: { titel: 'Beispielshop', impressum: 'Beispielshop, Musterweg 1', abmeldeAdresse: 'abmelden@beispiel.invalid', farben: {} },
    warteschlange: [eintrag]
  })
  await vorbereiten.festschreiben()

  const fn = {}
  let pluginDatenGeschrieben = 0
  starten({
    datenLaden: () => ({ _speicher: { modus: 'tabellen' } }), // die Markierung der Übernahme
    datenSpeichern: () => { pluginDatenGeschrieben++ },
    datenbank: db.datenbank,
    speicherSchema: db.schema,
    journalDatei: tempDatei('j.json'),
    bereitstellen: (name, f) => { fn[name] = f },
    fragen: async () => '',
    eingangOrdner: false,
    abrufen: async () => ({ ok: false, status: 500, json: async () => ({}) })
  })

  // Sofort aufgerufen, bevor geladen ist: der Aufruf wartet und liefert dann den echten Stand
  const uebersicht = await fn.uebersichtLesen()
  assert.deepEqual(uebersicht, { kampagnen: 2, geplantOderLaufend: 0, freigaben: 0, automationenAktiv: 1 })

  gesendet.length = 0
  const r = await fn.warteschlangeSchritt()
  assert.equal(r.gesendet, true, JSON.stringify(r))
  assert.deepEqual(gesendet, ['info@beispiel.invalid'])
  const w = (await db.roh(`SELECT zustand FROM ${db.schema}.warteschlange`)).rows
  assert.deepEqual(w, [{ zustand: 'gesendet' }], 'nach dem Versand festgeschrieben')
  const p = (await db.roh(`SELECT betreff, ok FROM ${db.schema}.protokoll`)).rows
  assert.deepEqual(p, [{ betreff: 'Probe', ok: true }], 'Protokollzeile in der Tabelle')

  const sperre = await fn.kontaktSperren({ email: 'a@beispiel.invalid' })
  assert.equal(sperre.ok, true, JSON.stringify(sperre))
  assert.equal((await db.roh(`SELECT gesperrt FROM ${db.schema}.kontakte WHERE schluessel = 'a@beispiel.invalid'`)).rows[0].gesperrt, true, 'Sperre sofort festgeschrieben')
  assert.equal(pluginDatenGeschrieben, 0, 'der alte Plugin-Speicher wird im Tabellenbetrieb nicht angefasst')
})
