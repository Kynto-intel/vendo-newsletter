'use strict'
// Newsletter-Plugin: der einzige Zugang zu den gespeicherten Daten.
//
// Alles Lesen und Schreiben läuft hier durch (Schritt N1 des PostgreSQL-Umbaus). Dahinter liegt einer von zwei
// Speichern mit derselben Schnittstelle:
//
//   - Standard: Vendos gemeinsamer Plugin-Speicher (`ctx.datenLaden`/`ctx.datenSpeichern`, in Vendo ein jsonb-Feld in
//     PostgreSQL); das Versandprotokoll liegt dann als Monatsdateien unter Vendos `daten/plugins/newsletter/`.
//   - Eigene Tabellen im Schema `newsletter` (Schritt N3, speicher-tabellen.js), mit dem Protokoll als Tabelle.
//     Gewählt, wenn die Plugin-Daten nur noch die Markierung `_speicher: { modus: 'tabellen' }` tragen; die setzt die
//     Übernahme der Daten in die Tabellen (Schritt N4). Bis dahin ändert sich am Betrieb nichts.
//
// `festschreiben` wartet, bis der Stand dauerhaft liegt: in der Datenbank oder, wenn sie nicht erreichbar ist, in
// einem Journal (Vendos `daten/speicher-offen/` beziehungsweise die Journaldatei des Tabellen-Speichers), das beim
// nächsten Start nachgeschrieben wird. Es gehört vor jeden Schritt nach außen, der sich nicht zurücknehmen lässt
// (SMTP-Versand, Mails im Postfach als gelesen markieren). Ohne `ctx.festschreiben` (Tests) tut es im Standard nichts.
//
// Der Tabellen-Speicher lädt beim Start asynchron. Bis dahin ist `istBereit()` falsch; haupt.js lässt Aufrufe dann
// auf `bereit` warten.

const { protokollSchreiben: dateiProtokollSchreiben, protokollLesen: dateiProtokollLesen } = require('./protokoll.js')
const { tabellenSpeicherMachen } = require('./speicher-tabellen.js')
const { SCHEMA } = require('./db.js')

const LISTEN = ['warteschlange', 'kontakte', 'kampagnen', 'vorlagen', 'automationen', 'laeufe', 'ruecklaeufer']
const BEREICHE = ['zugang', 'shopify', 'einstellungen', 'marke', 'drossel']
const MARKIERUNG = '_speicher'

// Gespeicherte Daten in die Form bringen, die der Rest erwartet: jede Liste ist eine Liste, jeder Bereich ein Objekt
function vervollstaendigen(roh) {
  const d = roh && typeof roh === 'object' ? roh : {}
  const aus = { ...d }
  delete aus[MARKIERUNG]
  for (const b of BEREICHE) aus[b] = d[b] || {}
  for (const l of LISTEN) aus[l] = Array.isArray(d[l]) ? d[l] : []
  return aus
}

// Welcher Speicher gilt: steht in den Plugin-Daten die Markierung der Übernahme, die Tabellen
const modusVon = (roh) => (roh && roh[MARKIERUNG]?.modus === 'tabellen' ? 'tabellen' : 'plugin')

// Standard: Vendos gemeinsamer Plugin-Speicher
function pluginSpeicherMachen(ctx, { protokollOrdner } = {}) {
  const lesen = () => vervollstaendigen(ctx.datenLaden())
  const speichern = (daten) => ctx.datenSpeichern(daten)
  const festschreiben = async () => {
    if (typeof ctx.festschreiben !== 'function') return
    try {
      await ctx.festschreiben()
    } catch {
      // Vendo hat den Stand dann ins Journal geschrieben und schreibt ihn nach; er ist also nicht verloren
    }
  }
  return {
    modus: 'plugin',
    bereit: Promise.resolve(),
    istBereit: () => true,
    lesen,
    speichern,
    festschreiben,
    protokollSchreiben: (eintrag) => dateiProtokollSchreiben(eintrag, protokollOrdner),
    protokollLesen: ({ anzahl = 50 } = {}) => dateiProtokollLesen({ anzahl, ordner: protokollOrdner }),
    zustand: () => ({ modus: 'plugin', geladen: true })
  }
}

// Eigene Tabellen. ctx.speicherSchema gibt es nur in Tests (eigenes Schema je Testlauf).
// Je Schema genau eine Instanz: Vendo ruft den Aufbau von haupt.js bei jedem Neuladen der Plugin-Liste erneut auf;
// zwei Zwischenspeicher derselben Tabellen würden sich gegenseitig überschreiben.
const tabellenInstanzen = new Map()
function tabellenSpeicherFuer(ctx, optionen = {}) {
  const schema = ctx.speicherSchema || SCHEMA
  if (!tabellenInstanzen.has(schema)) tabellenInstanzen.set(schema, tabellenSpeicherNeu(ctx, optionen))
  return tabellenInstanzen.get(schema)
}
function tabellenSpeicherNeu(ctx, { journalDatei } = {}) {
  const t = tabellenSpeicherMachen({ datenbank: ctx.datenbank, schema: ctx.speicherSchema || SCHEMA, journalDatei })
  const lesen = () => vervollstaendigen(t.lesen())
  const starten = () => t.laden().catch((f) => {
    console.warn(`Newsletter: Daten aus der Datenbank nicht ladbar: ${f.message}. Neuer Versuch, sobald sie bereit ist.`)
    setTimeout(starten, 10_000).unref?.()
  })
  if (!ctx.datenbank) console.warn('Newsletter: Tabellen-Speicher gewählt, aber Vendo stellt keine Datenbank bereit.')
  else if (typeof ctx.datenbank.bereit === 'function' && !ctx.datenbank.bereit() && typeof ctx.datenbank.beiBereit === 'function') {
    let gestartet = false
    ctx.datenbank.beiBereit(() => { if (!gestartet) { gestartet = true; starten() } })
  } else starten()
  return {
    ...t,
    lesen,
    festschreiben: async () => {
      try {
        await t.festschreiben()
      } catch {
        // Der Stand liegt dann im Journal; ein neuer Versuch läuft von selbst
      }
    }
  }
}

function speicherMachen(ctx, optionen = {}) {
  const roh = typeof ctx.datenLaden === 'function' ? ctx.datenLaden() : null
  const s = modusVon(roh) === 'tabellen' ? tabellenSpeicherFuer(ctx, optionen) : pluginSpeicherMachen(ctx, optionen)
  const feldSpeichern = (feld, wert) => {
    const d = s.lesen()
    d[feld] = wert
    s.speichern(d)
  }
  return { ...s, feldSpeichern }
}

module.exports = { speicherMachen, vervollstaendigen, modusVon, LISTEN, BEREICHE, MARKIERUNG }
