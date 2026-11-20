// Newsletter, Schritt N1 des PostgreSQL-Umbaus: alles Lesen und Schreiben läuft über speicher.js, und vor jedem
// Schritt nach außen, der sich nicht zurücknehmen lässt, wird festgeschrieben (SMTP-Versand, Mails als gelesen
// markieren). Kein Netz, kein echter Versand; SMTP, IMAP und Electron sind ersetzt, alle Daten erfunden.
//   node --test tests/newsletter-speicher.test.js

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { electronAufloesen } from './hilfen/electron-ersatz.cjs'
import speicherModul from '../speicher.js'
import ws from '../warteschlange.js'

process.env.VENDO_TEST_HERMES_HOME ||= path.join(os.tmpdir(), 'vendo-test-ohne-hermes')
const { speicherMachen, vervollstaendigen, LISTEN, BEREICHE } = speicherModul
const HIER = path.dirname(fileURLToPath(import.meta.url))
const WURZEL = path.join(HIER, '..')

// ── speicher.js für sich ──

test('vervollstaendigen: jede Liste ist eine Liste, jeder Bereich ein Objekt, Unbekanntes bleibt', () => {
  const d = vervollstaendigen({ kontakte: 'kaputt', marke: { titel: 'Beispielshop' }, ergebnisse: { namen: {} } })
  for (const l of LISTEN) assert.ok(Array.isArray(d[l]), l)
  for (const b of BEREICHE) assert.equal(typeof d[b], 'object', b)
  assert.equal(d.marke.titel, 'Beispielshop')
  assert.deepEqual(d.ergebnisse, { namen: {} })
  assert.deepEqual(vervollstaendigen(null).kontakte, [])
})

test('feldSpeichern liest frisch und ändert nur das eine Feld', () => {
  let gespeichert = { kontakte: [{ email: 'a@beispiel.invalid' }], marke: { titel: 'Beispielshop' } }
  const s = speicherMachen({ datenLaden: () => gespeichert, datenSpeichern: (d) => { gespeichert = d } })
  s.feldSpeichern('kampagnen', [{ id: 'k1' }])
  assert.deepEqual(gespeichert.kampagnen, [{ id: 'k1' }])
  assert.equal(gespeichert.kontakte.length, 1)
  assert.equal(gespeichert.marke.titel, 'Beispielshop')
})

test('festschreiben: ohne ctx.festschreiben nichts, ein Fehler dort bricht nichts ab', async () => {
  const ohne = speicherMachen({ datenLaden: () => ({}), datenSpeichern: () => {} })
  await ohne.festschreiben()
  let aufrufe = 0
  const mit = speicherMachen({ datenLaden: () => ({}), datenSpeichern: () => {}, festschreiben: async () => { aufrufe++; throw new Error('Datenbank weg') } })
  await mit.festschreiben()
  assert.equal(aufrufe, 1)
})

test('nur speicher.js fasst die Plugin-Daten direkt an', () => {
  const dateien = fs.readdirSync(WURZEL).filter((n) => n.endsWith('.js') && n !== 'speicher.js')
  for (const n of dateien) {
    const text = fs.readFileSync(path.join(WURZEL, n), 'utf8')
    assert.equal(/ctx\.(datenLaden|datenSpeichern|daten\.(laden|speichern))\b/.test(text), false, `${n} greift an speicher.js vorbei auf die Daten zu`)
  }
})

// ── Zusammenspiel in haupt.js ──

const require = createRequire(import.meta.url)
const ersatz = (pfad, exports) => {
  require.cache[pfad] = { id: pfad, filename: pfad, loaded: true, exports }
}
ersatz(electronAufloesen(), {
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (t) => Buffer.from(`test:${t}`),
    decryptString: (b) => Buffer.from(b).toString().slice(5)
  }
})
let beimSenden = null // wird je Test gesetzt: was beim SMTP-Aufruf geprüft wird
ersatz(require.resolve('nodemailer'), {
  createTransport: () => ({
    sendMail: async (mail) => {
      if (beimSenden) beimSenden(mail)
      return { messageId: 'x' }
    },
    close() {}
  })
})
const { default: starten } = await import('../haupt.js')

function imapErsatz(mails, beimMarkieren) {
  const markiert = []
  const client = {
    mailbox: { exists: mails.length },
    async connect() {},
    async getMailboxLock() {
      return { release() {} }
    },
    async *fetch() {
      for (const [i, quelle] of mails.entries()) yield { uid: 100 + i, source: Buffer.from(quelle) }
    },
    async messageFlagsAdd(bereich) {
      if (beimMarkieren) beimMarkieren()
      markiert.push(bereich)
    },
    async logout() {}
  }
  return { markiert, erzeuger: () => client }
}

const kontakt = (email, extra = {}) => ({ email, vorname: '', nachname: '', quelle: 'shopify', zustand: 'SUBSCRIBED', zustimmungAm: '2026-01-01', gesperrt: false, ...extra })

function hauptStarten({ warteschlange = [], mails = [], beimMarkieren = null } = {}) {
  let daten = {
    zugang: { benutzer: 'info@beispiel.invalid', passwortVerschluesselt: Buffer.from('test:nur-ein-test-passwort').toString('base64') },
    marke: { titel: 'Beispielshop', impressum: 'Beispielshop, Musterweg 1', abmeldeAdresse: 'abmelden@beispiel.invalid', farben: {} },
    kontakte: [kontakt('kim@kunden.invalid'), kontakt('lou@kunden.invalid')],
    kampagnen: [{ id: 'k1', name: 'Probe', zustand: 'freigabe' }, { id: 'k2', name: 'Zweite', zustand: 'laeuft' }],
    automationen: [{ id: 'a1', aktiv: true }, { id: 'a2', aktiv: false }],
    warteschlange
  }
  const fest = [] // je festschreiben: ein Abzug des gespeicherten Stands
  const imap = imapErsatz(mails, beimMarkieren && (() => beimMarkieren({ daten: () => daten, setzen: (d) => { daten = d }, fest })))
  const fn = {}
  starten({
    datenLaden: () => JSON.parse(JSON.stringify(daten)),
    datenSpeichern: (d) => { daten = JSON.parse(JSON.stringify(d)) },
    festschreiben: async () => { fest.push({ stand: JSON.parse(JSON.stringify(daten)), markiert: imap.markiert.length }) },
    bereitstellen: (name, f) => { fn[name] = f },
    fragen: async () => '',
    eingangOrdner: false,
    protokollOrdner: fs.mkdtempSync(path.join(os.tmpdir(), 'vendo-newsletter-speicher-')),
    imapErzeuger: imap.erzeuger,
    abrufen: async () => ({ ok: false, status: 500, json: async () => ({}) })
  })
  return { fn, daten: () => daten, fest, markiert: imap.markiert }
}

test('Versand: `sendet` ist festgeschrieben, bevor die Mail rausgeht, `gesendet` danach auch', async () => {
  const [e] = ws.einreihen([], [{ an: 'info@beispiel.invalid', betreff: 'Probe', html: '<p>x</p>', art: 'test' }]).liste
  const h = hauptStarten({ warteschlange: [e] })
  let festBeimSenden = null
  beimSenden = () => {
    festBeimSenden = h.fest.map((f) => f.stand.warteschlange[0].zustand)
  }
  try {
    const r = await h.fn.warteschlangeSchritt()
    assert.equal(r.gesendet, true, JSON.stringify(r))
  } finally {
    beimSenden = null
  }
  assert.deepEqual(festBeimSenden, ['sendet'], 'beim SMTP-Aufruf liegt `sendet` schon fest')
  assert.deepEqual(h.fest.map((f) => f.stand.warteschlange[0].zustand), ['sendet', 'gesendet'])
})

const RUECKLAEUFER = fs.readFileSync(path.join(HIER, 'fixtures', 'ruecklaeufer', 'dsn-hart.eml'), 'utf8')

test('Rückläufer: die Sperre liegt fest, bevor die Mail im Postfach als gelesen markiert wird', async () => {
  const h = hauptStarten({ mails: [RUECKLAEUFER] })
  const r = await h.fn.ruecklaeuferPruefen()
  assert.equal(r.ok, true, r.text)
  assert.equal(r.gesperrt, 1)
  assert.equal(h.markiert.length, 1)
  const vorMarkieren = h.fest.filter((f) => f.markiert === 0)
  assert.ok(vorMarkieren.length >= 1, 'vor dem Markieren festgeschrieben')
  const kim = vorMarkieren.at(-1).stand.kontakte.find((k) => k.email === 'kim@kunden.invalid')
  assert.equal(kim.gesperrt, true, 'die Sperre war schon im festgeschriebenen Stand')
})

test('Rückläufer: was während des Markierens gespeichert wird, überschreibt der Lauf nicht', async () => {
  const h = hauptStarten({
    mails: [RUECKLAEUFER],
    // Während das Postfach antwortet, legt jemand anderes (etwa die Oberfläche) eine Kampagne an
    beimMarkieren: ({ daten, setzen }) => setzen({ ...daten(), kampagnen: [...daten().kampagnen, { id: 'neu', name: 'Dazwischen', zustand: 'entwurf' }] })
  })
  const r = await h.fn.ruecklaeuferPruefen()
  assert.equal(r.ok, true, r.text)
  assert.ok(h.daten().kampagnen.some((k) => k.id === 'neu'), 'die Kampagne von dazwischen ist noch da')
  assert.equal(h.daten().kontakte.find((k) => k.email === 'kim@kunden.invalid').gesperrt, true)
  assert.match(h.daten().einstellungen.ruecklaeufer.letzterText, /1 gesperrt/)
})

test('uebersichtLesen liefert die Zahlen der Kacheln', () => {
  const h = hauptStarten()
  assert.deepEqual(h.fn.uebersichtLesen(), { kampagnen: 2, geplantOderLaufend: 1, freigaben: 1, automationenAktiv: 1 })
})
